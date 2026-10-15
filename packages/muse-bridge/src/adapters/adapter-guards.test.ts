import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { HttpAdapter, isAllowedHost } from "./http-adapter.js";
import { toCommandName } from "./mcp-adapter.js";

describe("HttpAdapter host guard", () => {
  it.each([
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["100.128.0.1", false],
    ["100.63.0.1", false],
    ["10.0.0.1", false],
    ["169.254.169.254", false],
    ["example.com", false],
  ])("%s -> %s", (host, ok) => {
    expect(isAllowedHost(host)).toBe(ok);
  });

  it("refuses a public URL in config", () => {
    expect(
      () =>
        new HttpAdapter("lilos", {
          "lilos.x": { options: { url: "https://example.com/run" } },
        }),
    ).toThrow("not loopback or Tailscale");
  });
});

describe("ClaudeCodeAdapter", () => {
  it("refuses bypassPermissions from config", () => {
    expect(
      () => new ClaudeCodeAdapter({ permission_mode: "bypassPermissions" }),
    ).toThrow("not allowed");
  });

  it("defaults to read-only plan mode and manual level, and requires cwd_allow", () => {
    const [cmd] = new ClaudeCodeAdapter().commands();
    expect(cmd?.description).toContain('"plan"');
    expect(cmd?.defaultLevel).toBe("manual");
    expect(cmd?.requiresCwdAllow).toBe(true);
  });

  it("refuses a relative cwd", async () => {
    const r = await new ClaudeCodeAdapter({ bin: "/bin/false" }).run(
      "claude.ask",
      { prompt: "hi", cwd: "repo" },
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 1000,
        log: () => {},
      },
    );
    expect(r.error?.code).toBe("invalid_params");
  });
});

describe("toCommandName", () => {
  it("normalises MCP tool names into Muse command names", () => {
    expect(toCommandName("grokbot", "Ask-Question")).toBe(
      "grokbot.ask_question",
    );
  });
});
