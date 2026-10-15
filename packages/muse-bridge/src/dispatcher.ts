/**
 * The single path every invoke takes: parse -> policy -> run (bounded) ->
 * cap output -> audit -> reply. It does not touch the network, so it is
 * unit-testable; the server feeds it `client.invoke` payloads and sends the
 * reply as `client.invoke.result`.
 *
 * Muse abandons an invoke after ~30s. Commands that may run longer go to the
 * JobStore: the reply is `{status:"accepted", job_id}` at once and the agent
 * polls the built-in `bridge.job_status` command.
 */
import { type AuditEntry, AuditLog, digest } from "./audit-log.js";
import type { CommandEntry } from "./command-table.js";
import { MUSE_INVOKE_WINDOW_SECONDS } from "./config.js";
import { JOB_STATUS_COMMAND, JobStore } from "./job-store.js";
import type { GateResult, PolicyGate } from "./policy.js";
import type { RunResult } from "./types.js";

const DEFAULT_MAX_OUTPUT = 256 * 1024;

export interface InvokeReply {
  readonly invoke_id: string;
  readonly ok: boolean;
  readonly payload_json?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface DispatcherOptions {
  readonly table: Map<string, CommandEntry>;
  readonly gate: PolicyGate;
  readonly audit?: AuditLog;
  readonly log?: (line: string) => void;
  /** Seconds a command may run inline before it becomes a job. Default: Muse's window. */
  readonly inlineSeconds?: number;
}

type Payload = Record<string, unknown>;

function fail(invokeId: string, code: string, message: string): InvokeReply {
  return { invoke_id: invokeId, ok: false, error: { code, message } };
}

function parseParams(raw: unknown): Payload | null {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Payload)
      : null;
  } catch {
    return null;
  }
}

export class Dispatcher {
  readonly #inflight = new Set<AbortController>();
  readonly #jobs = new JobStore();

  constructor(private readonly opts: DispatcherOptions) {}

  /** Cancel every running invoke and job (bridge stopping). */
  abortAll(): void {
    for (const c of this.#inflight) c.abort();
  }

  async handle(raw: unknown): Promise<InvokeReply | null> {
    const p = (raw ?? {}) as Payload;
    const invokeId = typeof p.invoke_id === "string" ? p.invoke_id.trim() : "";
    if (!invokeId) return null;
    const command = typeof p.command_id === "string" ? p.command_id : "";
    const params = parseParams(p.params_json);
    if (params === null)
      return fail(
        invokeId,
        "invalid_params",
        "params_json must be a JSON object",
      );

    // Built-in, read-only: report on a background job.
    if (command === JOB_STATUS_COMMAND) {
      const jobId = params.job_id;
      if (typeof jobId !== "string")
        return fail(invokeId, "invalid_params", "job_id is required");
      return this.#reply(
        invokeId,
        this.#jobs.status(jobId),
        DEFAULT_MAX_OUTPUT,
      );
    }

    const pd = digest(params);
    const base = {
      ts: new Date().toISOString(),
      invoke_id: invokeId,
      command,
      params_sha256: pd.sha256,
      params_bytes: pd.bytes,
    };
    const entry = this.opts.table.get(command);
    if (!entry) {
      await this.opts.audit?.write({
        ...base,
        level: null,
        decision: "deny",
        deny_code: "unknown_command",
      });
      return fail(
        invokeId,
        "unknown_command",
        `no command "${command}" on this bridge`,
      );
    }

    const decision = await this.opts.gate.decide(
      entry.level,
      { invokeId, command, params },
      entry.rules,
    );
    const decided = {
      ...base,
      level: entry.level,
      ...AuditLog.fromDecision(decision),
    };
    if (decision.kind === "deny") {
      this.opts.log?.(`deny ${command}: ${decision.code}`);
      await this.opts.audit?.write(decided);
      return fail(invokeId, decision.code, decision.reason);
    }

    const limitMs = Math.min(
      entry.spec.timeoutMs,
      entry.rules.max_seconds
        ? entry.rules.max_seconds * 1000
        : Number.POSITIVE_INFINITY,
    );
    const inlineMs =
      (this.opts.inlineSeconds ?? MUSE_INVOKE_WINDOW_SECONDS) * 1000;
    // Run with the gate's canonical params: the exact paths it checked.
    const work = this.#run(entry, decision.params, limitMs, decision, decided);

    if (limitMs <= inlineMs) {
      return this.#reply(
        invokeId,
        await work,
        entry.rules.max_output_bytes ?? DEFAULT_MAX_OUTPUT,
      );
    }
    const jobId = this.#jobs.start(command, work);
    this.opts.log?.(`${command} running as job ${jobId}`);
    return this.#reply(
      invokeId,
      {
        ok: true,
        payload: {
          status: "accepted",
          job_id: jobId,
          note: `This runs in the background. Call ${JOB_STATUS_COMMAND} with this job_id to get the result.`,
        },
      },
      DEFAULT_MAX_OUTPUT,
    );
  }

  /** Run the adapter with a deadline, release limits, and audit the outcome. */
  async #run(
    entry: CommandEntry,
    params: Payload,
    limitMs: number,
    decision: Extract<GateResult, { kind: "allow" }>,
    decided: AuditEntry,
  ): Promise<RunResult> {
    const ctrl = new AbortController();
    this.#inflight.add(ctrl);
    // The gate already reserved this run's slot; release it when done.
    const release = decision.release;
    const started = Date.now();
    let result: RunResult;
    try {
      this.opts.log?.(`run ${entry.spec.name} (${decision.via})`);
      result = await entry.adapter.run(entry.spec.name, params, {
        signal: ctrl.signal,
        deadline: started + limitMs,
        log: (line) => this.opts.log?.(`[${entry.spec.name}] ${line}`),
      });
    } catch (err) {
      result = {
        ok: false,
        error: { code: "adapter_failed", message: (err as Error).message },
      };
    } finally {
      release();
      this.#inflight.delete(ctrl);
    }
    const out =
      result.payload === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(result.payload));
    await this.opts.audit?.write({
      ...decided,
      ok: result.ok,
      error_code: result.error?.code,
      result_bytes: out,
      duration_ms: Date.now() - started,
    });
    return result;
  }

  #reply(invokeId: string, result: RunResult, maxBytes: number): InvokeReply {
    let payloadJson =
      result.payload === undefined ? undefined : JSON.stringify(result.payload);
    if (
      payloadJson !== undefined &&
      Buffer.byteLength(payloadJson) > maxBytes
    ) {
      payloadJson = JSON.stringify({
        truncated: true,
        preview: payloadJson.slice(0, Math.floor(maxBytes / 2)),
      });
    }
    return {
      invoke_id: invokeId,
      ok: result.ok,
      ...(payloadJson !== undefined ? { payload_json: payloadJson } : {}),
      ...(result.ok
        ? {}
        : {
            error: result.error ?? {
              code: "failed",
              message: "command failed",
            },
          }),
    };
  }
}
