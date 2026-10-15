/**
 * Shared types for the bridge: what a command looks like to Muse, how an
 * adapter runs it, and what the policy decides.
 */

/** Safeguard level for one command. */
export type Level = "full" | "auto" | "manual" | "off";

export const LEVELS: readonly Level[] = ["full", "auto", "manual", "off"];

/** Param types Muse understands in a device command spec. */
export type ParamType = "string" | "integer" | "number" | "boolean";

export interface ParamSpec {
  readonly type: ParamType;
  readonly description: string;
}

/** A command an adapter can expose, before policy is applied. */
export interface CommandSpec {
  /** Name Muse sees, e.g. `claude.ask`. Lowercase, dotted. */
  readonly name: string;
  readonly description: string;
  readonly required?: Record<string, ParamSpec>;
  readonly optional?: Record<string, ParamSpec>;
  /** Level used when config does not set one. Adapters suggest; config decides. */
  readonly defaultLevel: Level;
  /** Deadline Muse is told about, in ms. */
  readonly timeoutMs: number;
  /** The command touches local files: config must set `rules.cwd_allow`. */
  readonly requiresCwdAllow?: boolean;
}

export interface RunContext {
  readonly signal: AbortSignal;
  /** Absolute epoch ms by which the result must be returned. */
  readonly deadline: number;
  readonly log: (line: string) => void;
}

export interface RunResult {
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** One agent runtime the bridge can forward work to. */
export interface RuntimeAdapter {
  /** Stable id used as the config key, e.g. "claude-code". */
  readonly id: string;
  commands(): CommandSpec[];
  run(
    command: string,
    params: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

/** An invocation as it reaches the policy gate. */
export interface InvokeRequest {
  readonly invokeId: string;
  readonly command: string;
  readonly params: Record<string, unknown>;
}

/** Why the bridge allowed or refused one invoke. */
export type Decision =
  | { readonly kind: "allow"; readonly via: "full" | "auto" | "approval" }
  | { readonly kind: "deny"; readonly code: string; readonly reason: string };
