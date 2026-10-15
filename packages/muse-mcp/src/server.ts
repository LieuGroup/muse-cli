/**
 * Minimal newline-delimited JSON-RPC 2.0 MCP server over stdio.
 * Implements: initialize, tools/list, tools/call, ping.
 */
import { createInterface } from "node:readline";
import { MUSE_VERSION, MuseError } from "muse-agent-core";
import { callTool, type MuseConnection, TOOLS } from "./tools.js";

const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

type Id = string | number;
interface Request {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

export interface ServeOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly connection: MuseConnection;
  readonly log: (line: string) => void;
}

export function serve(opts: ServeOptions): Promise<void> {
  const send = (msg: unknown) => opts.output.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: Id, result: unknown) =>
    send({ jsonrpc: "2.0", id, result });
  const fail = (id: Id | null, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (req: Request): Promise<void> => {
    const id = req.id;
    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        const version = PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0];
        if (id !== undefined) {
          reply(id, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "muse-mcp", version: MUSE_VERSION },
            instructions:
              "Tools for driving the user's Muse (Meta AI) agent. Prefer muse_ask for conversation. Never pass allow_unsafe without the user's explicit OK.",
          });
        }
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        if (id !== undefined) reply(id, {});
        return;
      case "tools/list":
        if (id !== undefined) reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        if (id === undefined) return;
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await callTool(opts.connection, name, args);
          reply(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: Array.isArray(result)
              ? { items: result }
              : result,
          });
        } catch (err) {
          if (
            err instanceof MuseError &&
            (err.kind === "transport" || err.kind === "handshake")
          ) {
            opts.connection.reset();
          }
          reply(id, {
            isError: true,
            content: [
              { type: "text", text: (err as Error).message ?? String(err) },
            ],
          });
        }
        return;
      }
      default:
        if (id !== undefined)
          fail(id, -32601, `Method not found: ${req.method}`);
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: opts.input });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        fail(null, -32700, "Parse error");
        return;
      }
      handle(req).catch((err) => {
        opts.log(`muse-mcp: ${(err as Error).message}`);
        if (req.id !== undefined) fail(req.id, -32603, "Internal error");
      });
    });
    rl.on("close", () => {
      opts.connection.reset();
      resolve();
    });
  });
}
