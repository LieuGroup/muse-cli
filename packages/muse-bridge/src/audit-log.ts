/**
 * Append-only audit log (JSONL, mode 0600). Records what ran and why, but never
 * the parameters or results themselves: only a SHA-256 digest and sizes, so the
 * log cannot leak prompts, file contents or secrets.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Decision, Level } from "./types.js";

export const DEFAULT_AUDIT_PATH = join(
  homedir(),
  ".config",
  "muse",
  "bridge-audit.jsonl",
);

export interface AuditEntry {
  readonly ts: string;
  readonly invoke_id: string;
  readonly command: string;
  readonly level: Level | null;
  readonly decision: "allow" | "deny";
  readonly via?: string;
  readonly deny_code?: string;
  readonly params_sha256: string;
  readonly params_bytes: number;
  readonly ok?: boolean;
  readonly error_code?: string;
  readonly result_bytes?: number;
  readonly duration_ms?: number;
}

export function digest(value: unknown): { sha256: string; bytes: number } {
  const text = JSON.stringify(value ?? null);
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
}

export class AuditLog {
  constructor(readonly path = DEFAULT_AUDIT_PATH) {}

  async write(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Build the decision part of an entry. */
  static fromDecision(
    decision: Decision,
  ): Pick<AuditEntry, "decision" | "via" | "deny_code"> {
    return decision.kind === "allow"
      ? { decision: "allow", via: decision.via }
      : { decision: "deny", deny_code: decision.code };
  }

  async tail(n: number): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditEntry];
        } catch {
          return [];
        }
      });
  }
}
