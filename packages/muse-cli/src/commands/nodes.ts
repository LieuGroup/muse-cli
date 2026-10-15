import {
  type Command,
  type CommandContext,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import {
  bold,
  dim,
  relativeTime,
  table,
  toEpochMs,
  truncate,
} from "../render.js";

interface ParamSpec {
  type?: string;
  description?: string;
}

/** One entry of a node's `commands_v2` map, as returned by `node.list`. */
interface NodeCommandSpec {
  description?: string;
  permission_required?: string[];
  required?: Record<string, ParamSpec>;
  optional?: Record<string, ParamSpec>;
}

/** A device (Muse Mac or iOS app) paired with the agent VM. */
interface MuseNode {
  node_id: string;
  display_name?: string;
  platform?: string;
  version?: string;
  device_family?: string;
  online?: boolean;
  last_seen_at?: string;
  paired_at?: string;
  enabled_permissions?: string[];
  commands_v2?: Record<string, NodeCommandSpec>;
}

const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  mac: "macos",
  iphone: "ios",
};

/** Resolve a device by list index, node id prefix, display name or platform. */
function pickNode(nodes: MuseNode[], key: string): MuseNode | undefined {
  if (/^\d+$/.test(key)) return nodes[Number(key) - 1];
  const k = key.toLowerCase();
  const platform = PLATFORM_ALIASES[k] ?? k;
  return nodes.find(
    (node) =>
      node.node_id.startsWith(key) ||
      node.display_name?.toLowerCase() === k ||
      node.platform === platform,
  );
}

/** Permissions a command needs that the device has not granted. */
function missingPermissions(node: MuseNode, spec: NodeCommandSpec): string[] {
  const granted = new Set(node.enabled_permissions ?? []);
  return (spec.permission_required ?? []).filter((p) => !granted.has(p));
}

function commandEntries(node: MuseNode): [string, NodeCommandSpec][] {
  return Object.entries(node.commands_v2 ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
}

function deviceLabel(node: MuseNode): string {
  const name = node.display_name ?? node.node_id;
  return node.device_family ? `${name} (${node.device_family})` : name;
}

function appLabel(node: MuseNode): string {
  return [node.platform, node.version].filter(Boolean).join(" ") || "?";
}

/** First sentence of a description, on one line. */
function firstSentence(text: string | undefined, max: number): string {
  return truncate((text ?? "").split(/(?<=\.)\s/)[0] ?? "", max);
}

function renderList(ctx: CommandContext, nodes: MuseNode[]): void {
  if (nodes.length === 0) {
    ctx.io.out(
      "No devices paired. Sign in to the Muse app on your Mac or iPhone and it registers itself here.",
    );
    return;
  }
  const rows = nodes.map((node, i) => {
    const commands = commandEntries(node);
    const ready = commands.filter(
      ([, spec]) => missingPermissions(node, spec).length === 0,
    ).length;
    return [
      String(i + 1),
      deviceLabel(node),
      appLabel(node),
      node.online ? "online" : "offline",
      // last_seen_at goes stale while a device stays connected.
      node.online ? "now" : relativeTime(toEpochMs(node.last_seen_at)),
      `${ready}/${commands.length}`,
    ];
  });
  ctx.io.out(
    table(["#", "DEVICE", "APP", "STATE", "LAST SEEN", "READY"], rows),
  );
  ctx.io.out(
    dim(
      '\nCommands: muse nodes <#|mac|iphone>  ·  One command: muse nodes <#> <command>\nMuse calls these itself, e.g. muse ask "summarise my unread iMessages".',
    ),
  );
}

function renderNode(ctx: CommandContext, node: MuseNode): void {
  const state = node.online
    ? "online"
    : `offline, last seen ${relativeTime(toEpochMs(node.last_seen_at))}`;
  ctx.io.out(`${bold(deviceLabel(node))}  ${appLabel(node)} · ${state}`);
  ctx.io.out(
    dim(
      `node ${node.node_id} · paired ${relativeTime(toEpochMs(node.paired_at))}`,
    ),
  );
  const granted = node.enabled_permissions ?? [];
  ctx.io.out(
    `Permissions granted: ${granted.length > 0 ? granted.join(", ") : "none"}\n`,
  );
  const rows = commandEntries(node).map(([name, spec]) => {
    const missing = missingPermissions(node, spec);
    return [
      name,
      missing.length > 0 ? `needs ${missing.join(", ")}` : "ready",
      firstSentence(spec.description, 64),
    ];
  });
  ctx.io.out(table(["COMMAND", "STATUS", "ABOUT"], rows));
}

function renderCommand(
  ctx: CommandContext,
  node: MuseNode,
  name: string,
  spec: NodeCommandSpec,
): void {
  ctx.io.out(`${bold(name)}  on ${deviceLabel(node)}`);
  const needed = spec.permission_required ?? [];
  if (needed.length > 0) {
    const missing = missingPermissions(node, spec);
    const verdict =
      missing.length > 0 ? `missing ${missing.join(", ")}` : "all granted";
    ctx.io.out(`Permissions: ${needed.join(", ")} (${verdict})`);
  }
  ctx.io.out(`\n${spec.description ?? ""}`);
  const groups: [string, Record<string, ParamSpec> | undefined][] = [
    ["REQUIRED", spec.required],
    ["OPTIONAL", spec.optional],
  ];
  for (const [title, params] of groups) {
    const entries = Object.entries(params ?? {});
    if (entries.length === 0) continue;
    ctx.io.out(`\n${bold(title)}`);
    for (const [param, p] of entries) {
      const type = p.type ? ` (${p.type})` : "";
      ctx.io.out(`  ${param}${type}  ${p.description ?? ""}`);
    }
  }
}

/**
 * `muse nodes`                         devices paired via the Muse Mac/iOS app
 * `muse nodes <#|id|name|mac|iphone>`  that device's commands and what each needs
 * `muse nodes <#…> <command>`          full description and parameters of one command
 */
export const nodesCommand: Command = async (ctx) => {
  const [key, commandName] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("node.list", {})) as {
      nodes?: MuseNode[];
    };
    const nodes = res.nodes ?? [];
    if (!key) {
      if (ctx.json) printJson(ctx, nodes);
      else renderList(ctx, nodes);
      return EXIT.ok;
    }
    const node = pickNode(nodes, key);
    if (!node)
      usageError(
        `No device matches "${key}". Run \`muse nodes\` to list them.`,
      );
    if (!commandName) {
      if (ctx.json) printJson(ctx, node);
      else renderNode(ctx, node);
      return EXIT.ok;
    }
    const spec = node.commands_v2?.[commandName];
    if (!spec)
      usageError(
        `${deviceLabel(node)} has no command "${commandName}". Run \`muse nodes ${key}\`.`,
      );
    if (ctx.json) {
      printJson(ctx, {
        command: commandName,
        ...spec,
        missing_permissions: missingPermissions(node, spec),
      });
    } else {
      renderCommand(ctx, node, commandName, spec);
    }
    return EXIT.ok;
  });
};
