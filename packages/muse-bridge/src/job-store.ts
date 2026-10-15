/**
 * Background jobs for commands that outlast Muse's ~30s `device.invoke`
 * window. The invoke returns `{status: "accepted", job_id}` at once; the agent
 * then polls the built-in `bridge.job_status` command. Jobs live in memory and
 * are pruned an hour after they finish.
 */
import { randomUUID } from "node:crypto";
import type { RunResult } from "./types.js";

export const JOB_STATUS_COMMAND = "bridge.job_status";
const KEEP_MS = 3_600_000;
const MAX_JOBS = 200;

interface Job {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
  finishedAt: number | null;
  result: RunResult | null;
}

export class JobStore {
  readonly #jobs = new Map<string, Job>();

  /** Start `work` in the background and return its job id. */
  start(command: string, work: Promise<RunResult>): string {
    this.#prune();
    const job: Job = {
      id: randomUUID(),
      command,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
    };
    this.#jobs.set(job.id, job);
    work
      .catch(
        (err: unknown): RunResult => ({
          ok: false,
          error: { code: "adapter_failed", message: (err as Error).message },
        }),
      )
      .then((result) => {
        job.result = result;
        job.finishedAt = Date.now();
      });
    return job.id;
  }

  /** Status payload for `bridge.job_status`. */
  status(jobId: string): RunResult {
    const job = this.#jobs.get(jobId);
    if (!job)
      return {
        ok: false,
        error: {
          code: "unknown_job",
          message: "no such job (it may have expired)",
        },
      };
    if (!job.result) {
      return {
        ok: true,
        payload: {
          job_id: job.id,
          command: job.command,
          status: "running",
          running_seconds: Math.round((Date.now() - job.startedAt) / 1000),
        },
      };
    }
    return {
      ok: true,
      payload: {
        job_id: job.id,
        command: job.command,
        status: job.result.ok ? "succeeded" : "failed",
        result: job.result.payload ?? null,
        ...(job.result.error ? { error: job.result.error } : {}),
      },
    };
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > KEEP_MS)
        this.#jobs.delete(id);
    }
    while (this.#jobs.size >= MAX_JOBS) {
      const oldest = this.#jobs.keys().next().value;
      if (oldest === undefined) break;
      this.#jobs.delete(oldest);
    }
  }
}
