/**
 * Claude Code adapter: runs headless `claude -p` in an allowed folder and
 * returns its final answer.
 *
 * Claude's own permission mode comes from config, never from the request. The
 * adapter refuses `bypassPermissions`, and with `--permission-prompts none`
 * any tool use Claude would normally ask about is denied automatically, so the
 * bridge never hangs on a prompt nobody can see.
 *
 * Runtime options (runtimes.claude-code.options):
 *   bin             path to the claude binary (default: "claude" on PATH)
 *   permission_mode "plan" (default, read-only) | "acceptEdits" | "dontAsk" | "default"
 *   model           optional model id
 *   max_budget_usd  default 2; passed to Claude's own --max-budget-usd
 */
import { isAbsolute } from "node:path";
import type {
  CommandSpec,
  RunContext,
  RunResult,
  RuntimeAdapter,
} from "../types.js";
import { runProcess } from "./run-process.js";

const ALLOWED_MODES = new Set(["plan", "acceptEdits", "dontAsk", "default"]);

export interface ClaudeCodeOptions {
  readonly bin?: string;
  readonly permission_mode?: string;
  readonly model?: string;
  readonly max_budget_usd?: number;
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = "claude-code";
  readonly #bin: string;
  readonly #mode: string;
  readonly #model: string | undefined;
  readonly #budget: number;

  constructor(options: Record<string, unknown> = {}) {
    const o = options as ClaudeCodeOptions;
    const mode = o.permission_mode ?? "plan";
    if (!ALLOWED_MODES.has(mode)) {
      throw new Error(
        `claude-code: permission_mode "${mode}" is not allowed (use plan, acceptEdits, dontAsk or default)`,
      );
    }
    this.#bin = typeof o.bin === "string" ? o.bin : "claude";
    this.#mode = mode;
    this.#model = typeof o.model === "string" ? o.model : undefined;
    this.#budget =
      typeof o.max_budget_usd === "number" && o.max_budget_usd > 0
        ? o.max_budget_usd
        : 2;
  }

  commands(): CommandSpec[] {
    return [
      {
        name: "claude.ask",
        description: `Ask Claude Code on the user's machine to do a task in a local folder and return its answer. Claude runs in "${this.#mode}" permission mode.`,
        required: {
          prompt: {
            type: "string",
            description: "The task for Claude Code, in full.",
          },
          cwd: {
            type: "string",
            description:
              "Absolute folder to work in. Must be an allowed folder.",
          },
        },
        defaultLevel: "manual",
        timeoutMs: 900_000,
        requiresCwdAllow: true,
      },
    ];
  }

  async run(
    command: string,
    params: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    if (command !== "claude.ask") {
      return {
        ok: false,
        error: { code: "unknown_command", message: command },
      };
    }
    const { prompt, cwd } = params;
    if (
      typeof prompt !== "string" ||
      prompt.trim() === "" ||
      typeof cwd !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_params",
          message: "prompt and cwd are required strings",
        },
      };
    }
    if (!isAbsolute(cwd)) {
      return {
        ok: false,
        error: {
          code: "invalid_params",
          message: "cwd must be an absolute path",
        },
      };
    }
    const args = [
      "-p",
      "--output-format",
      "json",
      // Restricted mode removes code-running tools (Bash, REPL, WebFetch),
      // confines file tools to the working directory, ignores user/project
      // settings and refuses bypassPermissions.
      "--restricted",
      "--strict-mcp-config",
      "--add-dir",
      cwd,
      "--permission-mode",
      this.#mode,
      "--permission-prompts",
      "none",
      "--max-budget-usd",
      String(this.#budget),
      ...(this.#model ? ["--model", this.#model] : []),
    ];
    // The prompt goes on stdin, not argv, so it never shows up in `ps`.
    const res = await runProcess(this.#bin, args, {
      cwd,
      stdin: prompt,
      signal: ctx.signal,
      deadline: ctx.deadline,
      maxBytes: 1024 * 1024,
    });
    if (res.timedOut)
      return {
        ok: false,
        error: { code: "timeout", message: "Claude Code timed out" },
      };
    let out: Record<string, unknown> | null = null;
    try {
      out = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      // fall through
    }
    if (!out) {
      return {
        ok: false,
        error: {
          code: "bad_output",
          message: res.stderr.slice(0, 500) || `exited ${res.code}`,
        },
      };
    }
    const cost =
      typeof out.total_cost_usd === "number" ? out.total_cost_usd : null;
    const payload = {
      result: typeof out.result === "string" ? out.result : "",
      cost_usd: cost,
      turns: out.num_turns ?? null,
      permission_denials: Array.isArray(out.permission_denials)
        ? out.permission_denials.length
        : 0,
    };
    if (out.is_error === true) {
      return {
        ok: false,
        payload,
        error: {
          code: "claude_error",
          message: String(out.subtype ?? "error"),
        },
      };
    }
    return { ok: true, payload };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const ctrl = new AbortController();
    try {
      const res = await runProcess(this.#bin, ["--version"], {
        signal: ctrl.signal,
        deadline: Date.now() + 10_000,
      });
      return { ok: res.code === 0, detail: res.stdout.trim() };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
