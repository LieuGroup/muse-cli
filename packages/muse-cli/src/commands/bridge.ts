import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AuditLog,
  buildAdapters,
  buildCommandTable,
  DEFAULT_CONFIG_PATH,
  expandHome,
  loadBridgeConfig,
  readBridgePid,
  startBridge,
  starterConfig,
} from "muse-agent-bridge";
import { connectMuse } from "muse-agent-core";
import {
  type Command,
  type CommandContext,
  EXIT,
  printJson,
  usageError,
} from "../context.js";
import { flagNumber, flagString } from "../parse-argv.js";
import { dim, green, red, table, yellow } from "../render.js";
import {
  BRIDGE_LOG_PATH,
  installLaunchAgent,
  uninstallLaunchAgent,
} from "./bridge-launchd.js";

const configPath = (ctx: CommandContext) =>
  expandHome(flagString(ctx.args.flags, "config") ?? DEFAULT_CONFIG_PATH);

const LEVEL_COLOR = {
  full: red,
  auto: yellow,
  manual: green,
  off: dim,
} as const;

/** `muse bridge init [--channel macos|terminal|muse] [--repo DIR] [--force]` */
async function init(ctx: CommandContext): Promise<number> {
  const path = configPath(ctx);
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && ctx.args.flags.force !== true) {
    usageError(`${path} already exists. Pass --force to overwrite.`);
  }
  const channel = flagString(ctx.args.flags, "channel") ?? "macos";
  if (channel !== "macos" && channel !== "terminal" && channel !== "muse") {
    usageError("--channel must be macos, terminal or muse");
  }
  const repo = expandHome(flagString(ctx.args.flags, "repo") ?? process.cwd());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(starterConfig(channel, repo), null, 2)}\n`,
    { mode: 0o600 },
  );
  ctx.io.out(`Wrote ${path}`);
  ctx.io.out(
    dim("Review the levels, then: muse bridge commands  ·  muse bridge start"),
  );
  return EXIT.ok;
}

/** `muse bridge commands`: what Muse will see, with each level (offline). */
async function commands(ctx: CommandContext): Promise<number> {
  const config = await loadBridgeConfig(configPath(ctx));
  const built = await buildAdapters(config);
  try {
    const t = buildCommandTable(config, built.byRuntime);
    const rows = [...t].map(([name, e]) => ({
      command: name,
      runtime: e.runtimeId,
      level: e.level,
      rules: e.rules,
      description: e.spec.description,
    }));
    if (ctx.json) {
      printJson(ctx, rows);
      return EXIT.ok;
    }
    ctx.io.out(
      `${config.display_name} · approvals via ${config.approval.channel}\n`,
    );
    ctx.io.out(
      table(
        ["COMMAND", "RUNTIME", "LEVEL", "RULES"],
        rows.map((r) => [
          r.command,
          r.runtime,
          LEVEL_COLOR[r.level](r.level),
          Object.entries(r.rules)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)
            .join(" "),
        ]),
      ),
    );
    return EXIT.ok;
  } finally {
    built.stop();
  }
}

/** `muse bridge start [--foreground] [--config PATH]` */
async function start(ctx: CommandContext): Promise<number> {
  if (await readBridgePid())
    usageError("A bridge is already running. Stop it with `muse bridge stop`.");
  const config = await loadBridgeConfig(configPath(ctx));
  if (config.approval.channel === "terminal" && !process.stdin.isTTY) {
    usageError(
      'Approval channel "terminal" needs a terminal. Use "macos" or "muse" for background runs.',
    );
  }
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const stamp = () => new Date().toISOString().slice(11, 19);
  ctx.io.err(dim(`Starting bridge "${config.display_name}". Ctrl-C to stop.`));
  await startBridge({
    config,
    connect: async () =>
      connectMuse({
        cookie: await ctx.cookie(),
        vm: flagString(ctx.args.flags, "vm"),
      }),
    log: (line) => ctx.io.err(`${dim(stamp())} ${line}`),
    signal: ctrl.signal,
  });
  ctx.io.err("Bridge stopped.");
  return EXIT.ok;
}

/** `muse bridge stop`: the kill switch. Signals the running bridge. */
async function stopBridge(ctx: CommandContext): Promise<number> {
  const pid = await readBridgePid();
  if (!pid) {
    ctx.io.out("No bridge is running.");
    return EXIT.ok;
  }
  process.kill(pid, "SIGTERM");
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Give it time to unregister from Muse, then force it.
  for (let i = 0; i < 40 && alive(); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (alive()) {
    process.kill(pid, "SIGKILL");
    ctx.io.out(`Bridge (pid ${pid}) did not exit in 10s; killed it.`);
  } else {
    ctx.io.out(`Bridge stopped (pid ${pid}) and unregistered from Muse.`);
  }
  ctx.io.out(
    dim("If it runs under launchd and keeps restarting: muse bridge uninstall"),
  );
  return EXIT.ok;
}

async function status(ctx: CommandContext): Promise<number> {
  const pid = await readBridgePid();
  const audit = await new AuditLog().tail(1);
  const info = {
    running: pid != null,
    pid,
    config: configPath(ctx),
    last_invoke: audit[0] ?? null,
  };
  if (ctx.json) printJson(ctx, info);
  else {
    ctx.io.out(pid ? green(`running (pid ${pid})`) : "not running");
    ctx.io.out(dim(`config ${info.config}`));
    if (info.last_invoke) {
      const e = info.last_invoke;
      ctx.io.out(
        dim(
          `last invoke ${e.ts} ${e.command} ${e.decision}${e.deny_code ? ` (${e.deny_code})` : ""}`,
        ),
      );
    }
  }
  return EXIT.ok;
}

async function log(ctx: CommandContext): Promise<number> {
  const entries = await new AuditLog().tail(
    flagNumber(ctx.args.flags, "tail") ?? 20,
  );
  if (ctx.json) {
    printJson(ctx, entries);
    return EXIT.ok;
  }
  if (entries.length === 0) {
    ctx.io.out("No invokes yet.");
    return EXIT.ok;
  }
  ctx.io.out(
    table(
      ["TIME", "COMMAND", "LEVEL", "DECISION", "RESULT", "MS"],
      entries.map((e) => [
        e.ts.slice(0, 19).replace("T", " "),
        e.command,
        e.level ?? "-",
        e.decision === "allow"
          ? green(`allow (${e.via})`)
          : red(`deny (${e.deny_code})`),
        e.ok === undefined ? "-" : e.ok ? "ok" : `fail ${e.error_code ?? ""}`,
        e.duration_ms === undefined ? "-" : String(e.duration_ms),
      ]),
    ),
  );
  return EXIT.ok;
}

async function install(ctx: CommandContext): Promise<number> {
  const config = await loadBridgeConfig(configPath(ctx));
  if (config.approval.channel === "terminal") {
    usageError(
      'Background runs cannot use the "terminal" approval channel. Set approval.channel to "macos" or "muse".',
    );
  }
  const plist = await installLaunchAgent(configPath(ctx));
  ctx.io.out(`Installed ${plist}; the bridge now starts at login.`);
  ctx.io.out(dim(`Logs: ${BRIDGE_LOG_PATH}`));
  return EXIT.ok;
}

async function uninstall(ctx: CommandContext): Promise<number> {
  ctx.io.out(
    (await uninstallLaunchAgent())
      ? "Removed the login item."
      : "No login item was installed.",
  );
  return EXIT.ok;
}

/** `muse bridge <init|commands|start|stop|status|log|install|uninstall>` */
export const bridgeCommand: Command = async (ctx) => {
  const sub = ctx.args.positionals[0] ?? "status";
  switch (sub) {
    case "init":
      return init(ctx);
    case "commands":
      return commands(ctx);
    case "start":
      return start(ctx);
    case "stop":
      return stopBridge(ctx);
    case "status":
      return status(ctx);
    case "log":
      return log(ctx);
    case "install":
      return install(ctx);
    case "uninstall":
      return uninstall(ctx);
    default:
      usageError(
        "usage: muse bridge [init|commands|start|stop|status|log|install|uninstall]",
      );
  }
};
