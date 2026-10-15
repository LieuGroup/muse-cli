/** Small, dependency-free terminal rendering helpers. */

const useColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: number) => (text: string) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const dim = wrap(2);
export const bold = wrap(1);
export const green = wrap(32);
export const yellow = wrap(33);
export const red = wrap(31);
export const cyan = wrap(36);

/** Render rows as aligned columns. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [bold(line(headers)), ...rows.map(line)].join("\n");
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human time like "3m ago" / "in 2h" from epoch ms. */
export function relativeTime(
  ms: number | null | undefined,
  now = Date.now(),
): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return diff < 0 ? `${n}${unit} ago` : `in ${n}${unit}`;
    }
  }
  return "now";
}

/**
 * Parse the gateway's mixed timestamp formats to epoch ms: ISO strings,
 * epoch seconds, or epoch ms (as numbers or numeric strings).
 */
export function toEpochMs(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function formatBytes(n: number | undefined): string {
  if (n == null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
