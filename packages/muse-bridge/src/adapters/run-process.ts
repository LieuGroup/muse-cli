/**
 * Run a program with an argv array (never through a shell), bounded by a
 * deadline, an AbortSignal and an output cap. Shared by the shell and
 * claude-code adapters.
 */
import { spawn } from "node:child_process";
import { childEnv } from "./child-env.js";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  /** Max bytes kept per stream. Default 256 KiB. */
  readonly maxBytes?: number;
}

export function runProcess(
  command: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<ProcessResult> {
  const max = opts.maxBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // Never the bridge's own env: it may hold secrets the agent must not see.
      env: opts.env ?? childEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (current: string, chunk: Buffer): string => {
      if (current.length >= max) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString();
      if (next.length > max) truncated = true;
      return next.slice(0, max);
    };
    child.stdout.on("data", (c: Buffer) => {
      stdout = take(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = take(stderr, c);
    });
    const kill = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      Math.max(0, opts.deadline - Date.now()),
    );
    opts.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr, timedOut, truncated });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}
