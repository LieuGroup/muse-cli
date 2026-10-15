import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { serve } from "./server.js";
import { MuseConnection } from "./tools.js";

async function roundTrip(
  requests: unknown[],
): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const lines: string[] = [];
  const done = serve({
    input,
    output: { write: (chunk: string) => lines.push(chunk) },
    connection: new MuseConnection({}),
    log: () => {},
  });
  for (const r of requests) input.write(`${JSON.stringify(r)}\n`);
  await new Promise((r) => setTimeout(r, 50));
  input.end();
  await done;
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("muse-mcp", () => {
  it("initializes and lists tools", async () => {
    const [init, list] = await roundTrip([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const initResult = init?.result as { protocolVersion: string } | undefined;
    expect(initResult?.protocolVersion).toBe("2025-06-18");
    const listResult = list?.result as
      | { tools: { name: string }[] }
      | undefined;
    const names = listResult?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("muse_ask");
    expect(names).toContain("muse_call");
  });

  it("answers muse_methods offline and gates unsafe calls", async () => {
    const [methods, unsafe] = await roundTrip([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "muse_methods", arguments: { filter: "chat.stream" } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "muse_call", arguments: { method: "spaces.delete" } },
      },
    ]);
    expect(JSON.stringify(methods?.result)).toContain("/chat/stream");
    const u = unsafe?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(u.isError).toBe(true);
    expect(u.content[0]?.text).toContain("allow_unsafe");
  });
});
