/**
 * Media and artifacts produced by the agent.
 *
 * Generated media is announced in `delta.presentation` events whose payload
 * lists files as `sandbox://<path>` (path relative to /home/hatch). Files are
 * downloaded with the binary `fs.raw` route.
 */
import type { BinaryResult, GatewayEvent, MuseGateway } from "./gateway.js";

export interface MediaRef {
  /** Path relative to the agent's home, e.g. workspace/imagine_media/x.webp */
  readonly path: string;
  readonly kind: string;
  readonly mime?: string;
  readonly label?: string;
  readonly bytes?: number;
}

const SANDBOX = "sandbox://";

/** Normalize sandbox:// and absolute VM paths to the gateway's relative form. */
export function toVmPath(raw: string): string {
  return raw
    .replace(SANDBOX, "")
    .replace(/^\/home\/hatch\/?/, "")
    .replace(/^\/+/, "");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

function fileEntry(kind: string, v: unknown): MediaRef | null {
  const r = asRecord(v);
  const path = r && typeof r.path === "string" ? r.path : null;
  if (!r || !path || r.missing === true) return null;
  return {
    path: toVmPath(path),
    kind,
    ...(typeof r.mime === "string" ? { mime: r.mime } : {}),
    ...(typeof r.label === "string" ? { label: r.label } : {}),
    ...(typeof r.byte_len === "number" ? { bytes: r.byte_len } : {}),
  };
}

/** Extract downloadable files from one `delta.presentation` payload. */
export function mediaFromPresentation(payload: unknown): MediaRef[] {
  const p = asRecord(payload);
  if (!p) return [];
  const kind = typeof p.kind === "string" ? p.kind : "file";
  const data = asRecord(p.data) ?? {};
  const out: MediaRef[] = [];
  const push = (ref: MediaRef | null) => {
    if (ref && !out.some((x) => x.path === ref.path)) out.push(ref);
  };
  for (const key of ["images", "videos", "files", "tracks", "items"]) {
    const list = data[key];
    if (Array.isArray(list)) for (const v of list) push(fileEntry(kind, v));
  }
  for (const key of ["audio", "video", "file", "image"]) {
    push(fileEntry(kind, data[key]));
  }
  for (const key of ["image_path", "file_path", "audio_path", "video_path"]) {
    const v = p[key];
    if (typeof v === "string" && v) push({ path: toVmPath(v), kind });
  }
  return out;
}

/** Collect media from every presentation event in a list of events. */
export function mediaFromEvents(events: readonly GatewayEvent[]): MediaRef[] {
  const out: MediaRef[] = [];
  for (const ev of events) {
    if (ev.event !== "delta.presentation") continue;
    for (const ref of mediaFromPresentation(ev.payload)) {
      if (!out.some((x) => x.path === ref.path)) out.push(ref);
    }
  }
  return out;
}

/** Download a VM file as raw bytes. */
export async function downloadVmFile(
  gw: MuseGateway,
  path: string,
): Promise<BinaryResult> {
  return gw.request<BinaryResult>(
    "fs.raw",
    { path: toVmPath(path) },
    { binary: true, timeoutMs: 300_000 },
  );
}

export interface LibraryEntry {
  readonly name: string;
  readonly path: string;
  readonly size?: number;
  readonly modified_ms?: number;
  readonly media?: { kind?: string; mime_type?: string };
}

/** List the agent's library: generated/uploaded media, artifacts or recents. */
export async function listLibrary(
  gw: MuseGateway,
  preset: "media" | "artifacts" | "recents",
  limit = 50,
  offset = 0,
): Promise<{ entries: LibraryEntry[]; total: number; has_more: boolean }> {
  return gw.request("fs.library", { preset, limit, offset });
}
