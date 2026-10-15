// Test-only stdio MCP server: one read-only tool (`echo`) and one write tool.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Text" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  { name: "write-thing", description: "Writes", inputSchema: { type: "object", properties: {} } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${msg.params.arguments.text}` }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no method" } });
});
