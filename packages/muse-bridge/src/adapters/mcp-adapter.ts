/**
 * MCP adapter: exposes the tools of a local stdio MCP server (Grokbot, LilOS,
 * anything MCP) as Muse device commands named `<runtime-id>.<tool>`.
 *
 * Only tools listed in config are exposed; config decides each level. A tool's
 * `readOnlyHint` makes `auto` the suggested default, everything else `manual`.
 *
 * Runtime options: { "command": "grokbot-mcp", "args": [], "env": {} }
 */
import type {
  CommandSpec,
  ParamSpec,
  ParamType,
  RunContext,
  RunResult,
  RuntimeAdapter,
} from "../types.js";
import { McpStdioClient, type McpTool } from "./mcp-stdio-client.js";

const PARAM_TYPES = new Set<ParamType>([
  "string",
  "integer",
  "number",
  "boolean",
]);

/** MCP tool names may contain characters Muse command names do not allow. */
export function toCommandName(runtimeId: string, tool: string): string {
  const id = runtimeId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const t = tool.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `${id}.${t}`;
}

function toParams(tool: McpTool): {
  required: Record<string, ParamSpec>;
  optional: Record<string, ParamSpec>;
} {
  const props = tool.inputSchema?.properties ?? {};
  const req = new Set(tool.inputSchema?.required ?? []);
  const required: Record<string, ParamSpec> = {};
  const optional: Record<string, ParamSpec> = {};
  for (const [name, p] of Object.entries(props)) {
    const type = PARAM_TYPES.has(p.type as ParamType)
      ? (p.type as ParamType)
      : "string";
    const spec: ParamSpec = { type, description: p.description ?? name };
    (req.has(name) ? required : optional)[name] = spec;
  }
  return { required, optional };
}

export class McpAdapter implements RuntimeAdapter {
  readonly #client: McpStdioClient;
  readonly #byCommand = new Map<string, McpTool>();
  readonly #wanted: Set<string>;

  constructor(
    readonly id: string,
    options: Record<string, unknown>,
    exposedCommands: string[],
  ) {
    const command = options.command;
    if (typeof command !== "string")
      throw new Error(`${id}: options.command is required`);
    const args = Array.isArray(options.args) ? options.args.map(String) : [];
    const env =
      options.env &&
      typeof options.env === "object" &&
      !Array.isArray(options.env)
        ? Object.fromEntries(
            Object.entries(options.env).map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    this.#client = new McpStdioClient(command, args, env);
    this.#wanted = new Set(exposedCommands);
  }

  /** Start the server and learn its tools. Must run before `commands()`. */
  async init(): Promise<void> {
    await this.#client.start();
    for (const tool of await this.#client.listTools()) {
      const name = toCommandName(this.id, tool.name);
      if (this.#wanted.has(name)) this.#byCommand.set(name, tool);
    }
  }

  commands(): CommandSpec[] {
    return [...this.#byCommand].map(([name, tool]) => ({
      name,
      description: tool.description ?? tool.name,
      ...toParams(tool),
      defaultLevel: tool.annotations?.readOnlyHint === true ? "auto" : "manual",
      timeoutMs: 120_000,
    }));
  }

  async run(
    command: string,
    params: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    const tool = this.#byCommand.get(command);
    if (!tool)
      return {
        ok: false,
        error: { code: "unknown_command", message: command },
      };
    try {
      const res = (await this.#client.callTool(
        tool.name,
        params,
        Math.max(1, ctx.deadline - Date.now()),
      )) as {
        content?: { type: string; text?: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const payload = res.structuredContent ?? { text };
      return res.isError
        ? {
            ok: false,
            payload,
            error: { code: "tool_error", message: text.slice(0, 500) },
          }
        : { ok: true, payload };
    } catch (err) {
      return {
        ok: false,
        error: { code: "mcp_failed", message: (err as Error).message },
      };
    }
  }

  stop(): void {
    this.#client.stop();
  }
}
