import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  downloadVmFile,
  type MediaRef,
  type MuseGateway,
  toVmPath,
} from "muse-agent-core";
import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber, flagString } from "../parse-argv.js";
import {
  dim,
  formatBytes,
  relativeTime,
  table,
  toEpochMs,
  truncate,
} from "../render.js";

/** Download one VM file into a local directory. */
export async function saveVmFile(
  gw: MuseGateway,
  vmPath: string,
  dir: string,
): Promise<{ local: string; bytes: number; contentType: string | null }> {
  const res = await downloadVmFile(gw, vmPath);
  await mkdir(dir, { recursive: true });
  const local = join(dir, basename(toVmPath(vmPath)));
  await writeFile(local, res.bytes);
  return { local, bytes: res.bytes.length, contentType: res.contentType };
}

/** Download a list of media refs into a directory, logging each one. */
export async function saveMediaRefs(
  gw: MuseGateway,
  refs: readonly MediaRef[],
  dir: string,
  log: (line: string) => void,
): Promise<string[]> {
  const saved: string[] = [];
  for (const ref of refs) {
    try {
      const r = await saveVmFile(gw, ref.path, dir);
      saved.push(r.local);
      log(`saved ${ref.kind} -> ${r.local} (${formatBytes(r.bytes)})`);
    } catch (err) {
      log(`failed to save ${ref.path}: ${(err as Error).message}`);
    }
  }
  return saved;
}

interface ArtifactNode {
  artifact_ref: string;
  type: string;
  format?: string;
  display_name: string;
  updated_at_ms?: number;
  open_target?: { kind: string; path?: string; slug?: string };
}

function pickArtifact(
  nodes: ArtifactNode[],
  key: string,
): ArtifactNode | undefined {
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= nodes.length) return nodes[n - 1];
  const k = key.toLowerCase();
  return (
    nodes.find((a) => a.artifact_ref === key) ??
    nodes.find((a) => a.display_name.toLowerCase() === k) ??
    nodes.find((a) => a.display_name.toLowerCase().includes(k))
  );
}

async function downloadArtifact(
  gw: MuseGateway,
  a: ArtifactNode,
  dir: string,
): Promise<{ local: string; bytes: number }> {
  const target = a.open_target;
  if (target?.kind === "file" && target.path) {
    return saveVmFile(gw, target.path, dir);
  }
  if (target?.kind === "space" && target.slug) {
    const html = (await gw.request(
      "spaces.export_html",
      { slug: target.slug },
      { binary: true },
    )) as { bytes: Uint8Array };
    await mkdir(dir, { recursive: true });
    const local = join(dir, `${target.slug}.html`);
    await writeFile(local, html.bytes);
    return { local, bytes: html.bytes.length };
  }
  throw new Error(
    `artifact "${a.display_name}" (${target?.kind ?? "?"}) cannot be downloaded`,
  );
}

/** `muse artifacts [get <#|name> [dir]] [--type all|web|documents|shared]` */
export const artifactsCommand: Command = async (ctx) => {
  const [sub, key, dest] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("artifacts.list", {
      collection: flagString(ctx.args.flags, "type") ?? "all",
      first: flagNumber(ctx.args.flags, "limit") ?? 100,
    })) as { edges: { node: ArtifactNode }[]; total_count: number };
    const nodes = res.edges.map((e) => e.node);

    if (sub === "get") {
      if (!key) usageError("usage: muse artifacts get <#|name> [dir]");
      const a = pickArtifact(nodes, key);
      if (!a)
        usageError(`no artifact matches "${key}". Run \`muse artifacts\`.`);
      const r = await downloadArtifact(gateway, a, dest ?? ".");
      ctx.io.out(
        `Saved ${a.display_name} -> ${r.local} (${formatBytes(r.bytes)})`,
      );
      return EXIT.ok;
    }
    if (sub)
      usageError(
        "usage: muse artifacts [get <#|name> [dir]] [--type all|web|documents|shared]",
      );
    if (ctx.json) {
      printJson(ctx, nodes);
      return EXIT.ok;
    }
    const rows = nodes.map((a, i) => [
      String(i + 1),
      truncate(a.display_name, 44),
      a.format ?? a.type,
      relativeTime(toEpochMs(a.updated_at_ms)),
      a.open_target?.path
        ? truncate(toVmPath(a.open_target.path), 52)
        : (a.open_target?.slug ?? ""),
    ]);
    ctx.io.out(table(["#", "NAME", "TYPE", "UPDATED", "LOCATION"], rows));
    ctx.io.out(
      dim(
        `\n${res.total_count} artifacts. Download: muse artifacts get <#|name> [dir]`,
      ),
    );
    return EXIT.ok;
  });
};
