import { describe, expect, it } from "vitest";
import { buildCommandTable, deviceCommands } from "./command-table.js";
import { parseBridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { JOB_STATUS_COMMAND } from "./job-store.js";
import { PolicyGate } from "./policy.js";
import type { RuntimeAdapter } from "./types.js";

/** A slow runtime whose command declares a 10-minute limit. */
const slow: RuntimeAdapter = {
  id: "slow",
  commands: () => [
    {
      name: "slow.work",
      description: "Slow",
      defaultLevel: "manual",
      timeoutMs: 600_000,
    },
  ],
  run: async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, payload: { answer: 42 } };
  },
};

function setup() {
  const config = parseBridgeConfig({
    display_name: "t",
    runtimes: { slow: { commands: { "slow.work": { level: "full" } } } },
  });
  const table = buildCommandTable(config, new Map([["slow", slow]]));
  return {
    table,
    d: new Dispatcher({ table, gate: new PolicyGate(async () => true) }),
  };
}

const invoke = (command: string, params: unknown = {}) => ({
  invoke_id: `i-${Math.random()}`,
  command_id: command,
  params_json: JSON.stringify(params),
});

describe("background jobs", () => {
  it("a command longer than Muse's window returns a job id at once, then its result", async () => {
    const { d } = setup();
    const accepted = JSON.parse(
      (await d.handle(invoke("slow.work")))?.payload_json ?? "{}",
    );
    expect(accepted.status).toBe("accepted");

    const running = JSON.parse(
      (await d.handle(invoke(JOB_STATUS_COMMAND, { job_id: accepted.job_id })))
        ?.payload_json ?? "{}",
    );
    expect(running.status).toBe("running");

    await new Promise((r) => setTimeout(r, 100));
    const done = JSON.parse(
      (await d.handle(invoke(JOB_STATUS_COMMAND, { job_id: accepted.job_id })))
        ?.payload_json ?? "{}",
    );
    expect(done).toMatchObject({ status: "succeeded", result: { answer: 42 } });
  });

  it("advertises job_status and caps timeouts at Muse's window", () => {
    const { table } = setup();
    const cmds = deviceCommands(table) as Record<
      string,
      { timeout_ms: number; description: string }
    >;
    expect(cmds[JOB_STATUS_COMMAND]).toBeDefined();
    expect(cmds["slow.work"]?.timeout_ms).toBeLessThanOrEqual(25_000);
    expect(cmds["slow.work"]?.description).toContain(JOB_STATUS_COMMAND);
  });

  it("reports an unknown job", async () => {
    const { d } = setup();
    const r = await d.handle(invoke(JOB_STATUS_COMMAND, { job_id: "nope" }));
    expect(r?.error?.code).toBe("unknown_job");
  });

  it("refuses a config that claims the reserved job_status name", () => {
    const config = parseBridgeConfig({
      display_name: "t",
      runtimes: {
        slow: { commands: { [JOB_STATUS_COMMAND]: { level: "full" } } },
      },
    });
    expect(() => buildCommandTable(config, new Map([["slow", slow]]))).toThrow(
      "reserved",
    );
  });
});
