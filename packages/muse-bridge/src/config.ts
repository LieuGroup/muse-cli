/**
 * Bridge config: the only source of safeguard levels. Muse never edits it and
 * a request can never raise its own level. Validation is strict: unknown keys
 * and bad values are errors, never silently ignored.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MuseError } from "muse-agent-core";
import { LEVELS, type Level } from "./types.js";

export type ApprovalChannel = "terminal" | "macos" | "muse";

export interface CommandRules {
  /** Allowed path roots for any `cwd`/`path` param (`~` expanded). */
  readonly cwd_allow?: string[];
  /** Max runs per rolling hour. */
  readonly per_hour?: number;
  /** Max simultaneous runs. */
  readonly max_concurrent?: number;
  /** Max wall-clock seconds per run. */
  readonly max_seconds?: number;
  /** Max bytes of JSON params. */
  readonly max_input_bytes?: number;
  /** Max bytes of JSON result returned to Muse. */
  readonly max_output_bytes?: number;
}

export interface CommandConfig {
  readonly level: Level;
  readonly rules?: CommandRules;
  /** Adapter-specific settings (e.g. a shell template). */
  readonly options?: Record<string, unknown>;
}

export interface RuntimeConfig {
  readonly enabled: boolean;
  /** Adapter-wide settings (binary path, MCP server command, base URL…). */
  readonly options?: Record<string, unknown>;
  readonly commands: Record<string, CommandConfig>;
}

export interface BridgeConfig {
  /** Device name Muse shows; include the machine when running several bridges. */
  readonly display_name: string;
  readonly approval: {
    readonly channel: ApprovalChannel;
    readonly timeout_seconds: number;
  };
  readonly runtimes: Record<string, RuntimeConfig>;
}

/**
 * Muse abandons a `device.invoke` after 30s (`node_invoke_timeout`, verified
 * live). Approvals must resolve inside that window, with a little headroom.
 */
export const MUSE_INVOKE_WINDOW_SECONDS = 25;
const DEFAULT_APPROVAL_SECONDS = 25;

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "muse",
  "bridge.json",
);

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path;
}

function fail(path: string, message: string): never {
  throw new MuseError("config", `bridge config ${path}: ${message}`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === "object" && !Array.isArray(v);

function only(
  path: string,
  obj: Record<string, unknown>,
  keys: string[],
): void {
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) fail(path, `unknown key "${k}"`);
  }
}

function positiveInt(path: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    fail(path, "must be a positive integer");
  }
  return v;
}

function parseRules(path: string, raw: unknown): CommandRules | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) fail(path, "must be an object");
  only(path, raw, [
    "cwd_allow",
    "per_hour",
    "max_concurrent",
    "max_seconds",
    "max_input_bytes",
    "max_output_bytes",
  ]);
  const cwd = raw.cwd_allow;
  if (
    cwd !== undefined &&
    (!Array.isArray(cwd) || !cwd.every((c) => typeof c === "string"))
  ) {
    fail(`${path}.cwd_allow`, "must be an array of paths");
  }
  return {
    cwd_allow: cwd as string[] | undefined,
    per_hour: positiveInt(`${path}.per_hour`, raw.per_hour),
    max_concurrent: positiveInt(`${path}.max_concurrent`, raw.max_concurrent),
    max_seconds: positiveInt(`${path}.max_seconds`, raw.max_seconds),
    max_input_bytes: positiveInt(
      `${path}.max_input_bytes`,
      raw.max_input_bytes,
    ),
    max_output_bytes: positiveInt(
      `${path}.max_output_bytes`,
      raw.max_output_bytes,
    ),
  };
}

const COMMAND_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** Validate a parsed JSON value into a BridgeConfig. */
export function parseBridgeConfig(raw: unknown): BridgeConfig {
  if (!isObject(raw)) fail("$", "must be a JSON object");
  only("$", raw, ["display_name", "approval", "runtimes"]);
  const name = raw.display_name;
  if (typeof name !== "string" || name.trim() === "")
    fail("display_name", "required");

  const approvalRaw = raw.approval ?? {};
  if (!isObject(approvalRaw)) fail("approval", "must be an object");
  only("approval", approvalRaw, ["channel", "timeout_seconds"]);
  const channel = approvalRaw.channel ?? "terminal";
  if (channel !== "terminal" && channel !== "macos" && channel !== "muse") {
    fail("approval.channel", 'must be "terminal", "macos" or "muse"');
  }
  const timeout =
    positiveInt("approval.timeout_seconds", approvalRaw.timeout_seconds) ??
    DEFAULT_APPROVAL_SECONDS;
  if (timeout > MUSE_INVOKE_WINDOW_SECONDS) {
    fail(
      "approval.timeout_seconds",
      `must be at most ${MUSE_INVOKE_WINDOW_SECONDS}: Muse gives up on a device command after ~30s, so a later approval would run a command whose result nobody receives`,
    );
  }

  if (!isObject(raw.runtimes)) fail("runtimes", "must be an object");
  const runtimes: Record<string, RuntimeConfig> = {};
  for (const [id, rt] of Object.entries(raw.runtimes)) {
    const p = `runtimes.${id}`;
    if (!isObject(rt)) fail(p, "must be an object");
    only(p, rt, ["enabled", "options", "commands"]);
    if (rt.options !== undefined && !isObject(rt.options))
      fail(`${p}.options`, "must be an object");
    const cmds = rt.commands ?? {};
    if (!isObject(cmds)) fail(`${p}.commands`, "must be an object");
    const commands: Record<string, CommandConfig> = {};
    for (const [cmd, cc] of Object.entries(cmds)) {
      const cp = `${p}.commands.${cmd}`;
      if (!COMMAND_NAME.test(cmd)) fail(cp, "invalid command name");
      if (!isObject(cc)) fail(cp, "must be an object");
      only(cp, cc, ["level", "rules", "options"]);
      if (!LEVELS.includes(cc.level as Level))
        fail(`${cp}.level`, `must be one of ${LEVELS.join(", ")}`);
      if (cc.options !== undefined && !isObject(cc.options))
        fail(`${cp}.options`, "must be an object");
      commands[cmd] = {
        level: cc.level as Level,
        rules: parseRules(`${cp}.rules`, cc.rules),
        options: cc.options as Record<string, unknown> | undefined,
      };
    }
    runtimes[id] = {
      enabled: rt.enabled !== false,
      options: rt.options as Record<string, unknown> | undefined,
      commands,
    };
  }
  return {
    display_name: name.trim(),
    approval: { channel, timeout_seconds: timeout },
    runtimes,
  };
}

export async function loadBridgeConfig(
  path = DEFAULT_CONFIG_PATH,
): Promise<BridgeConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new MuseError(
      "config",
      `No bridge config at ${path}. Create one with \`muse bridge init\`.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new MuseError(
      "config",
      `bridge config ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseBridgeConfig(json);
}
