import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpAdapter } from "./mcp-adapter.js";

const server = fileURLToPath(
  new URL("./fake-mcp-server.test-helper.mjs", import.meta.url),
);
let adapter: McpAdapter | null = null;

afterEach(() => {
  adapter?.stop();
  adapter = null;
});

describe("McpAdapter", () => {
  it("exposes only configured tools, with suggested levels from annotations", async () => {
    adapter = new McpAdapter(
      "grokbot",
      { command: process.execPath, args: [server] },
      ["grokbot.echo", "grokbot.write_thing"],
    );
    await adapter.init();
    const cmds = Object.fromEntries(adapter.commands().map((c) => [c.name, c]));
    expect(Object.keys(cmds).sort()).toEqual([
      "grokbot.echo",
      "grokbot.write_thing",
    ]);
    expect(cmds["grokbot.echo"]?.defaultLevel).toBe("auto");
    expect(cmds["grokbot.write_thing"]?.defaultLevel).toBe("manual");
    expect(cmds["grokbot.echo"]?.required?.text?.type).toBe("string");
  });

  it("calls a tool and returns its text", async () => {
    adapter = new McpAdapter(
      "grokbot",
      { command: process.execPath, args: [server] },
      ["grokbot.echo"],
    );
    await adapter.init();
    const r = await adapter.run(
      "grokbot.echo",
      { text: "hi" },
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 5000,
        log: () => {},
      },
    );
    expect(r).toEqual({ ok: true, payload: { text: "echo:hi" } });
  });

  it("does not expose tools that config does not list", async () => {
    adapter = new McpAdapter(
      "grokbot",
      { command: process.execPath, args: [server] },
      ["grokbot.echo"],
    );
    await adapter.init();
    expect(adapter.commands().map((c) => c.name)).toEqual(["grokbot.echo"]);
  });
});
