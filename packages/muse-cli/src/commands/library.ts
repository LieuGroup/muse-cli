import { listLibrary, toVmPath } from "muse-agent-core";
import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber } from "../parse-argv.js";
import {
  dim,
  formatBytes,
  relativeTime,
  table,
  toEpochMs,
  truncate,
} from "../render.js";
import { saveMediaRefs, saveVmFile } from "./media.js";

/** `muse media [get <#|name|all> [dir]] [--limit N]` — images/audio/video. */
export const mediaCommand: Command = async (ctx) => {
  const [sub, key, dest] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    const limit = flagNumber(ctx.args.flags, "limit") ?? 50;
    const lib = await listLibrary(gateway, "media", limit);
    const entries = lib.entries;
    if (sub === "get") {
      if (!key) usageError("usage: muse media get <#|name|all> [dir]");
      const one =
        entries[Number(key) - 1] ?? entries.find((e) => e.name.includes(key));
      const picked = key === "all" ? entries : one ? [one] : [];
      if (picked.length === 0)
        usageError(`no media matches "${key}". Run \`muse media\`.`);
      const refs = picked.map((e) => ({
        path: e.path,
        kind: e.media?.kind ?? "media",
      }));
      await saveMediaRefs(gateway, refs, dest ?? ".", (l) => ctx.io.out(l));
      return EXIT.ok;
    }
    if (sub) usageError("usage: muse media [get <#|name|all> [dir]]");
    if (ctx.json) {
      printJson(ctx, lib);
      return EXIT.ok;
    }
    const rows = entries.map((e, i) => [
      String(i + 1),
      e.media?.kind ?? "-",
      formatBytes(e.size),
      relativeTime(toEpochMs(e.modified_ms)),
      truncate(toVmPath(e.path), 70),
    ]);
    ctx.io.out(table(["#", "KIND", "SIZE", "MODIFIED", "PATH"], rows));
    ctx.io.out(
      dim(`\n${lib.total} items. Download: muse media get <#|name|all> [dir]`),
    );
    return EXIT.ok;
  });
};

interface Episode {
  slug: string;
  title: string;
  path: string;
}

/** Podcast episodes are folders under workspace/podcasts/<slug>/<slug>.mp3. */
async function listEpisodes(
  request: (m: string, p: Record<string, unknown>) => Promise<unknown>,
): Promise<Episode[]> {
  const api = (await request("podcasts.episodes.list", {}).catch(
    () => null,
  )) as {
    episodes?: { slug?: string; title?: string; audio_path?: string }[];
  } | null;
  const fromApi = (api?.episodes ?? [])
    .filter((e) => e.slug && e.audio_path)
    .map((e) => ({
      slug: e.slug as string,
      title: e.title ?? (e.slug as string),
      path: toVmPath(e.audio_path as string),
    }));
  if (fromApi.length > 0) return fromApi;
  const ls = (await request("fs.list", { path: "workspace/podcasts" }).catch(
    () => null,
  )) as {
    entries?: { name: string; type: string }[];
  } | null;
  return (ls?.entries ?? [])
    .filter((e) => e.type === "directory")
    .map((e) => ({
      slug: e.name,
      title: e.name,
      path: `workspace/podcasts/${e.name}/${e.name}.mp3`,
    }));
}

/** `muse podcasts [get <#|slug> [dir]]` */
export const podcastsCommand: Command = async (ctx) => {
  const [sub, key, dest] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    const episodes = await listEpisodes((m, p) => gateway.request(m, p));
    if (sub === "get") {
      if (!key) usageError("usage: muse podcasts get <#|slug> [dir]");
      const ep =
        episodes[Number(key) - 1] ?? episodes.find((e) => e.slug.includes(key));
      if (!ep)
        usageError(`no episode matches "${key}". Run \`muse podcasts\`.`);
      const r = await saveVmFile(gateway, ep.path, dest ?? ".");
      ctx.io.out(`Saved ${ep.title} -> ${r.local} (${formatBytes(r.bytes)})`);
      return EXIT.ok;
    }
    if (sub) usageError("usage: muse podcasts [get <#|slug> [dir]]");
    if (ctx.json) {
      printJson(ctx, episodes);
      return EXIT.ok;
    }
    if (episodes.length === 0) {
      ctx.io.out(
        'No episodes yet. Try: muse ask "make a 1-minute podcast about …" --save-media .',
      );
      return EXIT.ok;
    }
    const rows = episodes.map((e, i) => [
      String(i + 1),
      truncate(e.title, 50),
      e.path,
    ]);
    ctx.io.out(table(["#", "EPISODE", "PATH"], rows));
    ctx.io.out(dim("\nDownload: muse podcasts get <#|slug> [dir]"));
    return EXIT.ok;
  });
};
