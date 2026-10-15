import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber } from "../parse-argv.js";
import { cyan, formatBytes, relativeTime, table } from "../render.js";
import { entryTime, type FsEntry, readVmFile, vmPath } from "./vm-path.js";

/** `muse ls [path] [--all]` */
export const lsCommand: Command = async (ctx) => {
  const path = vmPath(ctx.args.positionals[0]);
  return withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("fs.list", { path })) as {
      entries: FsEntry[];
    };
    if (ctx.json) {
      printJson(ctx, res.entries);
      return EXIT.ok;
    }
    const showHidden = ctx.args.flags.all === true;
    const entries = res.entries
      .filter((e) => showHidden || !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const rows = entries.map((e) => {
      const isDir = e.type === "directory";
      const name = isDir ? cyan(`${e.name}/`) : e.name;
      const size = isDir ? "-" : formatBytes(e.size);
      return [name, size, relativeTime(entryTime(e))];
    });
    ctx.io.out(table(["NAME", "SIZE", "MODIFIED"], rows));
    return EXIT.ok;
  });
};

/** `muse cat <path>` */
export const catCommand: Command = async (ctx) => {
  const path = vmPath(ctx.args.positionals[0]);
  if (!path) usageError("usage: muse cat <path>");
  return withGateway(ctx, async ({ gateway }) => {
    const bytes = await readVmFile((m, p) => gateway.request(m, p), path);
    ctx.io.write(Buffer.from(bytes).toString("utf8"));
    return EXIT.ok;
  });
};

/** `muse get <path> [local-file]` */
export const getCommand: Command = async (ctx) => {
  const [remote, local] = ctx.args.positionals;
  const path = vmPath(remote);
  if (!path) usageError("usage: muse get <vm-path> [local-file]");
  const target = local ?? basename(path);
  return withGateway(ctx, async ({ gateway }) => {
    const bytes = await readVmFile((m, p) => gateway.request(m, p), path);
    await writeFile(target, bytes);
    ctx.io.out(`Saved ${path} -> ${target} (${formatBytes(bytes.length)})`);
    return EXIT.ok;
  });
};

/** `muse put <local-file> <vm-path> [--append]` */
export const putCommand: Command = async (ctx) => {
  const [local, remote] = ctx.args.positionals;
  const path = vmPath(remote);
  if (!local || !path)
    usageError("usage: muse put <local-file> <vm-path> [--append]");
  const data = await readFile(local);
  const append = ctx.args.flags.append === true;
  return withGateway(ctx, async ({ gateway }) => {
    const res = await gateway.request("fs.write", {
      path,
      data_base64: data.toString("base64"),
      overwrite: !append,
      append,
      create_parent: true,
    });
    if (ctx.json) printJson(ctx, res);
    else ctx.io.out(`Wrote ${formatBytes(data.length)} -> ${path}`);
    return EXIT.ok;
  });
};

/** `muse find <name> [--in path] [--limit N]` */
export const findCommand: Command = async (ctx) => {
  const name = ctx.args.positionals.join(" ").trim();
  if (!name)
    usageError("usage: muse find <name-substring> [--in path] [--limit N]");
  const root = vmPath(
    typeof ctx.args.flags.in === "string" ? ctx.args.flags.in : "workspace",
  );
  return withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("fs.search", {
      path: root,
      name: { contains: name },
      limit: flagNumber(ctx.args.flags, "limit") ?? 50,
      offset: 0,
    })) as { entries: FsEntry[]; total: number };
    if (ctx.json) {
      printJson(ctx, res);
      return EXIT.ok;
    }
    const rows = res.entries.map((e) => [
      e.path ?? e.name,
      formatBytes(e.size),
      relativeTime(entryTime(e)),
    ]);
    ctx.io.out(table(["PATH", "SIZE", "MODIFIED"], rows));
    ctx.io.out(
      `\n${res.entries.length} of ${res.total} matches under ${root || "~"}`,
    );
    return EXIT.ok;
  });
};
