import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log.js";
import { buildCommandTable, deviceCommands } from "./command-table.js";
import { parseBridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { fakeAdapter } from "./fake-adapter.test-helper.js";
import { PolicyGate } from "./policy.js";

function setup(levels: Record<string, string>, approve = true) {
  const commands = Object.fromEntries(
    Object.entries(levels).map(([k, level]) => [
      k,
      {
        level,
        rules: k === "fake.big" ? { max_output_bytes: 500 } : undefined,
      },
    ]),
  );
  const config = parseBridgeConfig({
    display_name: "t",
    runtimes: { fake: { commands } },
  });
  const table = buildCommandTable(config, new Map([["fake", fakeAdapter]]));
  const auditPath = join(
    mkdtempSync(join(tmpdir(), "bridge-audit-")),
    "audit.jsonl",
  );
  const d = new Dispatcher({
    table,
    gate: new PolicyGate(async () => approve),
    audit: new AuditLog(auditPath),
  });
  return { d, table, auditPath };
}

const invoke = (command: string, params: unknown = {}) => ({
  invoke_id: "inv-1",
  command_id: command,
  params_json: JSON.stringify(params),
  timeout_ms: 5000,
});

describe("Dispatcher", () => {
  it("runs a full command and returns its payload", async () => {
    const { d } = setup({ "fake.echo": "full" });
    const r = await d.handle(invoke("fake.echo", { text: "hi" }));
    expect(r).toEqual({
      invoke_id: "inv-1",
      ok: true,
      payload_json: '{"echo":"hi"}',
    });
  });

  it("refuses unknown and off commands", async () => {
    const { d } = setup({ "fake.echo": "off" });
    expect((await d.handle(invoke("fake.echo")))?.error?.code).toBe(
      "unknown_command",
    );
    expect((await d.handle(invoke("nope")))?.error?.code).toBe(
      "unknown_command",
    );
  });

  it("denies a manual command the user refuses", async () => {
    const { d } = setup({ "fake.echo": "manual" }, false);
    expect(
      (await d.handle(invoke("fake.echo", { text: "x" })))?.error?.code,
    ).toBe("denied_by_user");
  });

  it("rejects malformed params and ignores invokes without an id", async () => {
    const { d } = setup({ "fake.echo": "full" });
    const bad = await d.handle({
      invoke_id: "i",
      command_id: "fake.echo",
      params_json: "[1]",
    });
    expect(bad?.error?.code).toBe("invalid_params");
    expect(await d.handle({ command_id: "fake.echo" })).toBeNull();
  });

  it("turns an adapter crash into an error reply", async () => {
    const { d } = setup({ "fake.boom": "full" });
    expect(await d.handle(invoke("fake.boom"))).toMatchObject({
      ok: false,
      error: { code: "adapter_failed" },
    });
  });

  it("caps oversized output", async () => {
    const { d } = setup({ "fake.big": "full" });
    const r = await d.handle(invoke("fake.big"));
    expect(Buffer.byteLength(r?.payload_json ?? "")).toBeLessThan(600);
    expect(JSON.parse(r?.payload_json ?? "{}").truncated).toBe(true);
  });

  it("audits a digest, never the params themselves", async () => {
    const { d, auditPath } = setup({ "fake.echo": "full" });
    await d.handle(invoke("fake.echo", { text: "SECRET-VALUE-123" }));
    const log = readFileSync(auditPath, "utf8");
    expect(log).toContain('"command":"fake.echo"');
    expect(log).toContain("params_sha256");
    expect(log).not.toContain("SECRET-VALUE-123");
  });
});

describe("deviceCommands wire format", () => {
  it("encodes param types as Muse's numeric codes and tags the level", () => {
    const { table } = setup({ "fake.echo": "manual" });
    const cmd = deviceCommands(table)["fake.echo"] as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(cmd.required?.text?.type).toBe(1);
    expect(cmd.optional?.n?.type).toBe(2);
    expect(String(cmd.description)).toContain("[bridge level: manual]");
  });

  it("refuses a file-touching command configured without cwd_allow", async () => {
    const { ClaudeCodeAdapter } = await import(
      "./adapters/claude-code-adapter.js"
    );
    const config = parseBridgeConfig({
      display_name: "t",
      runtimes: {
        "claude-code": { commands: { "claude.ask": { level: "manual" } } },
      },
    });
    expect(() =>
      buildCommandTable(
        config,
        new Map([["claude-code", new ClaudeCodeAdapter()]]),
      ),
    ).toThrow("needs rules.cwd_allow");
  });

  it("fails loudly when config names a command the runtime lacks", () => {
    const config = parseBridgeConfig({
      display_name: "t",
      runtimes: { fake: { commands: { "fake.nope": { level: "full" } } } },
    });
    expect(() =>
      buildCommandTable(config, new Map([["fake", fakeAdapter]])),
    ).toThrow('no command "fake.nope"');
  });
});
