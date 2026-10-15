/**
 * Join adapter command specs with config into the table the bridge serves.
 * A command is exposed only when config names it under its runtime and its
 * level is not `off`. Command names must be unique across runtimes.
 */
import {
  type BridgeConfig,
  type CommandRules,
  MUSE_INVOKE_WINDOW_SECONDS,
} from "./config.js";
import { JOB_STATUS_COMMAND } from "./job-store.js";
import type { CommandSpec, Level, ParamType, RuntimeAdapter } from "./types.js";

export interface CommandEntry {
  readonly spec: CommandSpec;
  readonly runtimeId: string;
  readonly adapter: RuntimeAdapter;
  readonly level: Level;
  readonly rules: CommandRules;
}

/**
 * `client.register_capabilities` takes numeric param types (verified live);
 * `node.list` reports them back as names.
 */
export const WIRE_PARAM_TYPE: Readonly<Record<ParamType, number>> = {
  string: 1,
  integer: 2,
  number: 3,
  boolean: 4,
};

function wireParams(params: CommandSpec["required"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(params ?? {})) {
    out[name] = {
      type: WIRE_PARAM_TYPE[p.type],
      description: p.description,
      enum_values: [],
    };
  }
  return out;
}

export function buildCommandTable(
  config: BridgeConfig,
  byRuntime: ReadonlyMap<string, RuntimeAdapter>,
): Map<string, CommandEntry> {
  const table = new Map<string, CommandEntry>();
  for (const [runtimeId, adapter] of byRuntime) {
    const rt = config.runtimes[runtimeId];
    if (!rt?.enabled) continue;
    const specs = new Map(adapter.commands().map((s) => [s.name, s]));
    for (const [name, cc] of Object.entries(rt.commands)) {
      if (name === JOB_STATUS_COMMAND) {
        throw new Error(`"${name}" is reserved for the bridge itself`);
      }
      const spec = specs.get(name);
      if (!spec) {
        throw new Error(
          `runtime "${runtimeId}" has no command "${name}" (available: ${[...specs.keys()].join(", ") || "none"})`,
        );
      }
      if (table.has(name))
        throw new Error(`command "${name}" is defined by two runtimes`);
      if (cc.level === "off") continue;
      if (spec.requiresCwdAllow && !cc.rules?.cwd_allow?.length) {
        throw new Error(
          `command "${name}" works on local files and needs rules.cwd_allow (the folders it may use)`,
        );
      }
      table.set(name, {
        spec,
        runtimeId,
        adapter,
        level: cc.level,
        rules: cc.rules ?? {},
      });
    }
  }
  return table;
}

/** How long a command may run: its spec timeout, capped by `max_seconds`. */
export function commandLimitMs(e: CommandEntry): number {
  const max = e.rules.max_seconds;
  return max ? Math.min(e.spec.timeoutMs, max * 1000) : e.spec.timeoutMs;
}

/** The `device_commands` map for `client.register_capabilities`. */
export function deviceCommands(
  table: Map<string, CommandEntry>,
): Record<string, unknown> {
  const windowMs = MUSE_INVOKE_WINDOW_SECONDS * 1000;
  const out: Record<string, unknown> = {};
  let anyJobs = false;
  for (const [name, e] of table) {
    const isJob = commandLimitMs(e) > windowMs;
    anyJobs ||= isJob;
    out[name] = {
      description:
        `${e.spec.description} [bridge level: ${e.level}]` +
        (isJob
          ? ` Long-running: returns {status:"accepted", job_id}; then call ${JOB_STATUS_COMMAND}.`
          : ""),
      required: wireParams(e.spec.required),
      optional: wireParams(e.spec.optional),
      permissions: [],
      datatype: "application/json",
      // Muse gives up after ~30s, so never advertise more.
      timeout_ms: Math.min(commandLimitMs(e), windowMs),
    };
  }
  if (anyJobs) {
    out[JOB_STATUS_COMMAND] = {
      description:
        "Get the status and result of a background job started by another command on this bridge. Read-only.",
      required: {
        job_id: {
          type: WIRE_PARAM_TYPE.string,
          description: "The job_id returned when the job was accepted.",
          enum_values: [],
        },
      },
      optional: {},
      permissions: [],
      datatype: "application/json",
      timeout_ms: 10_000,
    };
  }
  return out;
}
