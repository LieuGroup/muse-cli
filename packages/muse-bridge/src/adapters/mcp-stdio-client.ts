/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): initialize,
 * tools/list, tools/call. Enough to expose an MCP server's tools to Muse.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { childEnv } from "./child-env.js";

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  readonly annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class McpStdioClient {
  #child: ChildProcess | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: childEnv(this.env),
      shell: false,
    });
    this.#child = child;
    child.on("exit", () => {
      for (const p of this.#pending.values())
        p.reject(new Error("MCP server exited"));
      this.#pending.clear();
      this.#child = null;
    });
    const rl = createInterface({
      input: child.stdout as NodeJS.ReadableStream,
    });
    rl.on("line", (line) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
      else p.resolve(msg.result);
    });
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "muse-agent-bridge", version: "0.1.0" },
    });
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  #write(msg: unknown): void {
    if (!this.#child?.stdin) throw new Error("MCP server is not running");
    this.#child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return res.tools ?? [];
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  stop(): void {
    this.#child?.kill("SIGTERM");
    this.#child = null;
  }
}
