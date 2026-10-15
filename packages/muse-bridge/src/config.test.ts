import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "./config.js";
import { starterConfig } from "./starter-config.js";

const base = {
  display_name: "Test bridge",
  runtimes: {
    shell: {
      commands: { "t.ok": { level: "full", options: { argv: ["true"] } } },
    },
  },
};

describe("parseBridgeConfig", () => {
  it("applies defaults", () => {
    const c = parseBridgeConfig(base);
    expect(c.approval).toEqual({ channel: "terminal", timeout_seconds: 25 });
    expect(c.runtimes.shell?.enabled).toBe(true);
  });

  it("accepts the starter config", () => {
    const c = parseBridgeConfig(starterConfig("macos", "/tmp/repo"));
    expect(c.approval.channel).toBe("macos");
    expect(c.runtimes["claude-code"]?.commands["claude.ask"]?.level).toBe(
      "manual",
    );
    expect(c.runtimes.lilos?.enabled).toBe(false);
  });

  it.each([
    [{ ...base, extra: 1 }, 'unknown key "extra"'],
    [{ ...base, display_name: " " }, "display_name"],
    [{ ...base, approval: { channel: "sms" } }, "approval.channel"],
    [{ ...base, approval: { timeout_seconds: 120 } }, "at most 25"],
    [
      {
        ...base,
        runtimes: { shell: { commands: { "t.ok": { level: "yolo" } } } },
      },
      "level",
    ],
    [
      {
        ...base,
        runtimes: { shell: { commands: { "Bad Name": { level: "full" } } } },
      },
      "invalid command name",
    ],
    [
      {
        ...base,
        runtimes: {
          shell: {
            commands: { "t.ok": { level: "full", rules: { per_hour: -1 } } },
          },
        },
      },
      "per_hour",
    ],
    [
      {
        ...base,
        runtimes: {
          shell: {
            commands: { "t.ok": { level: "full", rules: { sudo: true } } },
          },
        },
      },
      'unknown key "sudo"',
    ],
  ])("rejects invalid config %#", (raw, message) => {
    expect(() => parseBridgeConfig(raw)).toThrow(message);
  });
});
