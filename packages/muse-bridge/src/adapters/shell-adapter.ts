/**
 * Shell adapter: runs fixed command templates from config. There is no
 * free-form shell. A template is an argv array; `{name}` items are replaced by
 * the matching string param as one whole argv item, so a param cannot add
 * pipes or extra commands, and values starting with "-" are refused so it
 * cannot add options either.
 *
 * Config (per command, under runtimes.shell.commands.<name>.options):
 *   { "argv": ["bun", "run", "verify"], "cwd": "~/repo",
 *     "description": "Run the test suite", "params": { "file": "Test file" } }
 */
import { expandHome } from "../config.js";
import type {
  CommandSpec,
  ParamSpec,
  RunContext,
  RunResult,
  RuntimeAdapter,
} from "../types.js";
import { runProcess } from "./run-process.js";

interface ShellTemplate {
  readonly argv: string[];
  readonly cwd?: string;
  readonly description: string;
  readonly params: Record<string, string>;
}

const PLACEHOLDER = /^\{([a-z_][a-z0-9_]*)\}$/;

function parseTemplate(
  name: string,
  options: Record<string, unknown> | undefined,
): ShellTemplate {
  const argv = options?.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((a) => typeof a === "string")
  ) {
    throw new Error(
      `shell command ${name}: options.argv must be a non-empty string array`,
    );
  }
  const params: Record<string, string> = {};
  const raw = options?.params;
  if (raw !== undefined) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `shell command ${name}: options.params must be an object`,
      );
    }
    for (const [k, v] of Object.entries(raw)) params[k] = String(v);
  }
  for (const item of argv) {
    const m = PLACEHOLDER.exec(item);
    if (m?.[1] && !(m[1] in params)) {
      throw new Error(
        `shell command ${name}: placeholder {${m[1]}} has no params entry`,
      );
    }
  }
  if (PLACEHOLDER.test(argv[0] as string)) {
    throw new Error(
      `shell command ${name}: the program itself cannot be a placeholder`,
    );
  }
  return {
    argv: argv as string[],
    cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
    description:
      typeof options?.description === "string"
        ? options.description
        : `Run: ${argv.join(" ")}`,
    params,
  };
}

export class ShellAdapter implements RuntimeAdapter {
  readonly id = "shell";
  readonly #templates = new Map<string, ShellTemplate>();

  constructor(commands: Record<string, { options?: Record<string, unknown> }>) {
    for (const [name, cfg] of Object.entries(commands)) {
      this.#templates.set(name, parseTemplate(name, cfg.options));
    }
  }

  commands(): CommandSpec[] {
    return [...this.#templates].map(([name, t]) => {
      const required: Record<string, ParamSpec> = {};
      for (const [p, desc] of Object.entries(t.params)) {
        required[p] = { type: "string", description: desc };
      }
      return {
        name,
        description: t.description,
        required,
        defaultLevel: "manual",
        timeoutMs: 120_000,
      };
    });
  }

  async run(
    command: string,
    params: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    const t = this.#templates.get(command);
    if (!t)
      return {
        ok: false,
        error: { code: "unknown_command", message: command },
      };
    const argv: string[] = [];
    for (const item of t.argv) {
      const m = PLACEHOLDER.exec(item);
      if (!m?.[1]) {
        argv.push(item);
        continue;
      }
      const v = params[m[1]];
      if (typeof v !== "string" || v.length === 0 || v.includes("\0")) {
        return {
          ok: false,
          error: {
            code: "invalid_params",
            message: `${m[1]} must be a non-empty string`,
          },
        };
      }
      // A value starting with "-" would be parsed as an option by the program
      // (e.g. `rg -f/etc/passwd`, `git log --output=…`): refuse it.
      if (v.startsWith("-")) {
        return {
          ok: false,
          error: {
            code: "invalid_params",
            message: `${m[1]} must not start with "-"`,
          },
        };
      }
      argv.push(v);
    }
    const [program, ...args] = argv as [string, ...string[]];
    const res = await runProcess(program, args, {
      cwd: t.cwd ? expandHome(t.cwd) : undefined,
      signal: ctx.signal,
      deadline: ctx.deadline,
    });
    const payload = {
      exit_code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      ...(res.truncated ? { truncated: true } : {}),
    };
    if (res.timedOut)
      return {
        ok: false,
        payload,
        error: { code: "timeout", message: "command timed out" },
      };
    return {
      ok: res.code === 0,
      payload,
      ...(res.code === 0
        ? {}
        : { error: { code: "exit_nonzero", message: `exited ${res.code}` } }),
    };
  }
}
