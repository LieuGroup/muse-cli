/**
 * Files live in the agent VM's home (/home/hatch). The gateway takes paths
 * relative to that root and rejects absolute ones.
 */
export function vmPath(input: string | undefined): string {
  const raw = (input ?? "").trim();
  return raw
    .replace(/^~\/?/, "")
    .replace(/^\/home\/hatch\/?/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export interface FsEntry {
  name: string;
  type: string;
  path?: string;
  size?: number;
  modified_ms?: number;
  modifiedAt?: string;
}

export function entryTime(e: FsEntry): number | undefined {
  if (e.modified_ms != null) return e.modified_ms;
  if (e.modifiedAt) {
    const t = Date.parse(e.modifiedAt);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

type Request = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

interface ReadChunk {
  eof: boolean;
  len: number;
  data_base64?: string;
}

const READ_CHUNK = 1024 * 1024;
const MAX_READ = 50 * 1024 * 1024;

/** Read a whole VM file in 1 MiB chunks. */
export async function readVmFile(
  request: Request,
  path: string,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = (await request("fs.read", {
      path,
      offset,
      len: READ_CHUNK,
    })) as ReadChunk;
    const bytes = chunk.data_base64
      ? new Uint8Array(Buffer.from(chunk.data_base64, "base64"))
      : new Uint8Array(0);
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.eof || bytes.length === 0) break;
    if (offset > MAX_READ)
      throw new Error(`file is larger than ${MAX_READ} bytes`);
  }
  return Buffer.concat(parts);
}
