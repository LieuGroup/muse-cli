/**
 * Policy gate: decides, per invoke, whether to run now, ask the user, or
 * refuse. The level comes only from config; params cannot change it.
 *
 * - full:   run now; hard rules (size, paths, rate, concurrency) still apply.
 * - auto:   run now when every soft rule passes; a miss falls back to manual.
 * - manual: always ask the user.
 * - off:    never registered; an invoke for it is refused.
 *
 * Concurrency and rate are reserved atomically inside `decide()`: the slot is
 * taken in the same synchronous step as the check, so a burst of invokes cannot
 * all pass before any of them is counted.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type CommandRules, expandHome } from "./config.js";
import type { Decision, InvokeRequest, Level } from "./types.js";

/** Asks the user; resolves true for Allow. */
export type Approver = (req: InvokeRequest, reason: string) => Promise<boolean>;

const DEFAULT_MAX_INPUT = 64 * 1024;
/** Approval prompts allowed per command per minute, and in flight at once. */
const MAX_PROMPTS_PER_MINUTE = 6;
const MAX_PENDING_PROMPTS = 3;

/**
 * Request text that tries to talk the bridge into more access. This only turns
 * `auto` into a prompt; it is a tripwire, not a security boundary. The level in
 * config is the boundary.
 */
const ESCALATION = [
  /ignore (all |any )?(previous|prior) (instructions|rules)/i,
  /\b(set|change|raise|switch)\b.{0,20}\b(level|permission|policy)\b/i,
  /dangerously-skip-permissions|bypassPermissions/i,
];

/**
 * Resolve symlinks through the nearest existing ancestor, then re-append the
 * rest, so a path that does not exist yet still canonicalises consistently
 * with its root (macOS `/var` -> `/private/var`).
 */
export function canonicalPath(path: string): string {
  const abs = resolve(expandHome(path));
  const rest: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** True when `path` is one of `roots` or inside one (symlinks resolved). */
export function isWithin(path: string, roots: readonly string[]): boolean {
  const target = canonicalPath(path);
  return roots.some((root) => {
    const r = canonicalPath(root);
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/** Param names that are always treated as paths, whatever they contain. */
const PATH_KEYS = new Set([
  "cwd",
  "path",
  "dir",
  "directory",
  "repo",
  "file",
  "folder",
]);

/** A string param that looks like a filesystem path. */
function looksLikePath(v: string): boolean {
  return (
    isAbsolute(v) || v.startsWith("~") || v.startsWith(".") || v.includes(sep)
  );
}

type Allow = Extract<Decision, { kind: "allow" }>;

/** An allow decision carries its reserved slot and the validated params. */
export type GateResult =
  | (Allow & {
      readonly release: () => void;
      readonly params: Record<string, unknown>;
    })
  | Extract<Decision, { kind: "deny" }>;

export class PolicyGate {
  readonly #history = new Map<string, number[]>();
  readonly #running = new Map<string, number>();
  readonly #prompts = new Map<string, number[]>();
  #pendingPrompts = 0;

  constructor(private readonly approve: Approver) {}

  /**
   * Hard rule on paths. With `cwd_allow`, EVERY string param that looks like a
   * path must be inside an allowed root; it is replaced by its canonical form
   * so the adapter runs exactly what was checked (no `~`, no symlink swap).
   */
  #checkPaths(
    params: Record<string, unknown>,
    roots: readonly string[] | undefined,
  ):
    | { ok: true; params: Record<string, unknown> }
    | { ok: false; key: string } {
    if (!roots) return { ok: true, params };
    const out: Record<string, unknown> = { ...params };
    for (const [key, v] of Object.entries(params)) {
      // A well-known path key must be a string path; anything else is refused.
      if (PATH_KEYS.has(key) && typeof v !== "string")
        return { ok: false, key };
      if (typeof v !== "string" || !(PATH_KEYS.has(key) || looksLikePath(v)))
        continue;
      if (!isWithin(v, roots)) return { ok: false, key };
      out[key] = canonicalPath(v);
    }
    return { ok: true, params: out };
  }

  /** Check and reserve concurrency + rate in one synchronous step. */
  #reserve(
    command: string,
    rules: CommandRules,
  ): Extract<Decision, { kind: "deny" }> | (() => void) {
    const running = this.#running.get(command) ?? 0;
    if (rules.max_concurrent !== undefined && running >= rules.max_concurrent) {
      return {
        kind: "deny",
        code: "busy",
        reason: `already running ${running}`,
      };
    }
    const cutoff = Date.now() - 3_600_000;
    const recent = (this.#history.get(command) ?? []).filter((t) => t > cutoff);
    if (rules.per_hour !== undefined && recent.length >= rules.per_hour) {
      return {
        kind: "deny",
        code: "rate_limited",
        reason: `${recent.length} runs in the last hour`,
      };
    }
    recent.push(Date.now());
    this.#history.set(command, recent);
    this.#running.set(command, running + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running.set(
        command,
        Math.max(0, (this.#running.get(command) ?? 1) - 1),
      );
    };
  }

  /** Approval prompts are rate-limited so a flood cannot fatigue the user. */
  #mayPrompt(command: string): boolean {
    if (this.#pendingPrompts >= MAX_PENDING_PROMPTS) return false;
    const cutoff = Date.now() - 60_000;
    const recent = (this.#prompts.get(command) ?? []).filter((t) => t > cutoff);
    if (recent.length >= MAX_PROMPTS_PER_MINUTE) return false;
    recent.push(Date.now());
    this.#prompts.set(command, recent);
    return true;
  }

  async decide(
    level: Level,
    req: InvokeRequest,
    rules: CommandRules = {},
  ): Promise<GateResult> {
    if (level === "off") {
      return {
        kind: "deny",
        code: "command_disabled",
        reason: "this command is off",
      };
    }
    const size = Buffer.byteLength(JSON.stringify(req.params));
    if (size > (rules.max_input_bytes ?? DEFAULT_MAX_INPUT)) {
      return {
        kind: "deny",
        code: "input_too_large",
        reason: `params are ${size} bytes`,
      };
    }
    const checked = this.#checkPaths(req.params, rules.cwd_allow);
    if (!checked.ok) {
      return {
        kind: "deny",
        code: "path_not_allowed",
        reason: `${checked.key} is outside the allowed folders`,
      };
    }
    const { params } = checked;

    let via: Allow["via"];
    if (level === "full") via = "full";
    else {
      const escalation = ESCALATION.some((re) =>
        re.test(JSON.stringify(params)),
      );
      if (level === "auto" && !escalation) via = "auto";
      else {
        if (!this.#mayPrompt(req.command)) {
          return {
            kind: "deny",
            code: "approval_rate_limited",
            reason: "too many approval requests; try again shortly",
          };
        }
        this.#pendingPrompts++;
        let allowed = false;
        try {
          allowed = await this.approve(
            { ...req, params },
            escalation
              ? "the request asks for more access"
              : "this command needs your approval",
          );
        } catch {
          allowed = false;
        } finally {
          this.#pendingPrompts--;
        }
        if (!allowed)
          return {
            kind: "deny",
            code: "denied_by_user",
            reason: "the user did not approve",
          };
        via = "approval";
      }
    }
    // Reserve after any await, in one synchronous step with the check.
    const reserved = this.#reserve(req.command, rules);
    if (typeof reserved !== "function") return reserved;
    return { kind: "allow", via, release: reserved, params };
  }
}
