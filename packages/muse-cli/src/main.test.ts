import type { ConnectedMuse, GatewayEvent, MuseGateway } from "muse-agent-core";
import { describe, expect, it } from "vitest";
import { vmPath } from "./commands/vm-path.js";
import { EXIT, run } from "./main.js";
import { parseArgv } from "./parse-argv.js";

type Handler = (params: Record<string, unknown>) => unknown;

/** A fake gateway that answers `request()` from a method→handler table. */
function fakeConnect(handlers: Record<string, Handler>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const gateway = {
    vmType: "standard",
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`unexpected ${method}`);
      return h(params);
    },
    subscribe: (
      method: string,
      params: Record<string, unknown>,
      onEvent: (e: GatewayEvent) => void,
    ) => {
      calls.push({ method, params });
      const events = (handlers[method]?.(params) ?? []) as GatewayEvent[];
      for (const e of events) onEvent(e);
      return {
        ack: Promise.resolve({}),
        done: Promise.resolve(),
        close: () => {},
      };
    },
    onEvent: () => () => {},
    close: () => {},
  } as unknown as MuseGateway;
  const connected = {
    gateway,
    vm: { vmName: "vm-1", vmId: "vm-1", vmState: "RUNNING" },
  } as unknown as ConnectedMuse;
  return { connect: async () => connected, calls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      write: (t: string) => out.push(t),
    },
    out,
    err,
    text: () => out.join("\n"),
  };
}

describe("parseArgv", () => {
  it("splits command, positionals and flags", () => {
    expect(
      parseArgv(["ask", "hello", "world", "--thread", "s1", "--json", "--k=v"]),
    ).toEqual({
      command: "ask",
      positionals: ["hello", "world"],
      flags: { thread: "s1", json: true, k: "v" },
    });
  });
});

describe("vmPath", () => {
  it("normalizes home-relative paths", () => {
    expect(vmPath("~/workspace/a.md")).toBe("workspace/a.md");
    expect(vmPath("/home/hatch/docs/")).toBe("docs");
    expect(vmPath(undefined)).toBe("");
  });
});

describe("muse CLI", () => {
  it("prints help with no command", async () => {
    const c = capture();
    expect(await run([], c.io)).toBe(EXIT.ok);
    expect(c.text()).toContain('ask "<message>"');
  });

  it("rejects unknown commands", async () => {
    const c = capture();
    expect(await run(["frobnicate"], c.io)).toBe(EXIT.usage);
  });

  it("lists methods from the catalog offline", async () => {
    const c = capture();
    expect(await run(["methods", "chat.stream"], c.io)).toBe(EXIT.ok);
    expect(c.text()).toContain("/chat/stream");
  });

  it("requires a contact point for auth login", async () => {
    const c = capture();
    expect(await run(["auth", "login"], c.io)).toBe(EXIT.usage);
    expect(c.err.join("\n")).toContain("--email");
  });

  it("refuses to send a code with no terminal and no --code-command", async () => {
    const c = capture();
    const tty = process.stdin.isTTY;
    const saved = process.env.MUSE_CODE_COMMAND;
    process.stdin.isTTY = false;
    delete process.env.MUSE_CODE_COMMAND;
    try {
      expect(await run(["login", "login", "--email", "a@b.co"], c.io)).toBe(
        EXIT.usage,
      );
      expect(c.err.join("\n")).toContain("--code-command");
    } finally {
      process.stdin.isTTY = tty;
      if (saved !== undefined) process.env.MUSE_CODE_COMMAND = saved;
    }
  });

  it("bridge init writes a safe config that bridge commands can read", async () => {
    const { mkdtempSync, readFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(
      mkdtempSync(join(tmpdir(), "bridge-cli-")),
      "bridge.json",
    );
    const c = capture();
    expect(
      await run(["bridge", "init", "--config", path, "--repo", "/tmp"], c.io),
    ).toBe(EXIT.ok);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).approval.channel).toBe(
      "macos",
    );
    expect(await run(["bridge", "init", "--config", path], capture().io)).toBe(
      EXIT.usage,
    );

    const list = capture();
    expect(
      await run(["bridge", "commands", "--config", path, "--json"], list.io),
    ).toBe(EXIT.ok);
    const rows = JSON.parse(list.text()) as {
      command: string;
      level: string;
    }[];
    expect(rows.map((r) => `${r.command}=${r.level}`).sort()).toEqual([
      "bridge.uptime=full",
      "claude.ask=manual",
    ]);
  });

  it("rejects unknown auth subcommands", async () => {
    expect(await run(["auth", "frobnicate"], capture().io)).toBe(EXIT.usage);
  });

  it("refuses unsafe calls without --allow-unsafe", async () => {
    const c = capture();
    expect(await run(["call", "spaces.delete", '{"slug":"x"}'], c.io)).toBe(
      EXIT.usage,
    );
    expect(c.err.join("\n")).toContain("--allow-unsafe");
  });

  it("shows models and marks the selected one", async () => {
    const c = capture();
    const f = fakeConnect({
      "model.get": () => ({
        selected_model: "auto/auto",
        default_model: "auto/auto",
        available_models: [
          {
            id: "auto/auto",
            display_name: "Auto",
            context_window_tokens: 350000,
          },
          { id: "ipnext/x", display_name: "X", context_window_tokens: 128000 },
        ],
      }),
    });
    expect(await run(["model"], c.io, f)).toBe(EXIT.ok);
    expect(c.text()).toMatch(/\*\s+auto\/auto/);
    expect(c.text()).toContain("350k");
  });

  it("sets reasoning effort and reads it back", async () => {
    const c = capture();
    let effort = "high";
    const f = fakeConnect({
      "config.get": () => ({
        llm: { reasoning: { root_agent: { effort }, subagent: { effort } } },
      }),
      "config.update": (p) => {
        effort = (
          p as { llm: { reasoning: { root_agent: { effort: string } } } }
        ).llm.reasoning.root_agent.effort;
        return {};
      },
    });
    expect(await run(["effort", "low"], c.io, f)).toBe(EXIT.ok);
    expect(f.calls.find((x) => x.method === "config.update")?.params).toEqual({
      llm: {
        reasoning: {
          root_agent: { effort: "low" },
          subagent: { effort: "low" },
        },
      },
    });
    expect(c.text()).toContain("low");
  });

  it("lists files and uses relative paths", async () => {
    const c = capture();
    const f = fakeConnect({
      "fs.list": () => ({
        path: "workspace",
        entries: [
          {
            name: "notes.md",
            type: "file",
            size: 2048,
            modified_ms: Date.now(),
          },
          { name: "docs", type: "directory" },
          { name: ".secret", type: "file" },
        ],
      }),
    });
    expect(await run(["ls", "~/workspace/"], c.io, f)).toBe(EXIT.ok);
    expect(f.calls[0]?.params).toEqual({ path: "workspace" });
    expect(c.text()).toContain("docs/");
    expect(c.text()).toContain("notes.md");
    expect(c.text()).not.toContain(".secret");
  });

  it("reads a file across chunks with cat", async () => {
    const c = capture();
    const f = fakeConnect({
      "fs.read": (p) =>
        p.offset === 0
          ? {
              eof: false,
              len: 6,
              data_base64: Buffer.from("hello ").toString("base64"),
            }
          : {
              eof: true,
              len: 5,
              data_base64: Buffer.from("world").toString("base64"),
            },
    });
    expect(await run(["cat", "HEARTBEAT.md"], c.io, f)).toBe(EXIT.ok);
    expect(c.out.join("")).toBe("hello world");
  });

  it("lists scheduled tasks with readable cadence", async () => {
    const c = capture();
    const f = fakeConnect({
      "tasks.list": () => ({
        schedules: [
          {
            id: "heartbeat",
            title: null,
            path: "/home/hatch/workspace/cron.d/minutely/heartbeat",
            mode: "heartbeat",
            enabled: true,
            is_heartbeat: true,
            next_run_at_utc: Math.floor(Date.now() / 1000) + 600,
            timezone: "UTC",
            cadence: { kind: "interval", interval_seconds: 1800 },
          },
        ],
      }),
    });
    expect(await run(["tasks"], c.io, f)).toBe(EXIT.ok);
    expect(c.text()).toContain("every 30m");
    expect(c.text()).toContain("heartbeat");
  });

  it("creates a thread with session.start + rename", async () => {
    const c = capture();
    const f = fakeConnect({
      "session.start": () => ({}),
      "session.rename": () => ({}),
    });
    expect(
      await run(["threads", "new", "Trip", "plan", "--json"], c.io, f),
    ).toBe(EXIT.ok);
    const start = f.calls.find((x) => x.method === "session.start");
    expect(start?.params).toMatchObject({
      params: { origin: "fresh", lifecycle: "persistent" },
    });
    const rename = f.calls.find((x) => x.method === "session.rename");
    expect(rename?.params).toMatchObject({ title: "Trip plan" });
  });

  describe("nodes", () => {
    const nodeList = () => ({
      nodes: [
        {
          node_id: "f858f73d-ios",
          display_name: "iPhone",
          platform: "ios",
          version: "11.0.0",
          device_family: "iPhone18,4",
          online: false,
          last_seen_at: "2026-10-14T09:31:42.346435858+00:00",
          enabled_permissions: ["photos"],
          commands_v2: {
            "location.get": { permission_required: ["location"] },
          },
        },
        {
          node_id: "012ec163-mac",
          display_name: "Studio",
          platform: "macos",
          version: "7.0",
          device_family: "Mac17,8",
          online: true,
          enabled_permissions: ["full_disk_access", "imessage_read"],
          commands_v2: {
            "imessage.search": {
              description: "Read local iMessage/SMS, newest first. More text.",
              permission_required: ["full_disk_access", "imessage_read"],
              optional: { query: { type: "string", description: "Text." } },
            },
            "imessage.send": {
              description: "Send text from this Mac as the user.",
              permission_required: ["full_disk_access", "imessage_automation"],
              required: {
                thread_key: { type: "string", description: "Thread." },
                body: { type: "string", description: "Exact text." },
              },
            },
          },
        },
      ],
    });

    it("lists devices with online state and ready counts", async () => {
      const c = capture();
      const f = fakeConnect({ "node.list": nodeList });
      expect(await run(["nodes"], c.io, f)).toBe(EXIT.ok);
      expect(f.calls[0]).toEqual({ method: "node.list", params: {} });
      expect(c.text()).toContain("iPhone (iPhone18,4)");
      expect(c.text()).toMatch(/Studio \(Mac17,8\)\s+macos 7\.0\s+online/);
      expect(c.text()).toMatch(/online\s+now\s+1\/2/);
      expect(c.text()).toMatch(/offline\s+\S+ ago\s+0\/1/);
    });

    it("shows a device's commands and flags missing permissions", async () => {
      const c = capture();
      const f = fakeConnect({ "node.list": nodeList });
      expect(await run(["devices", "mac"], c.io, f)).toBe(EXIT.ok);
      expect(c.text()).toContain("full_disk_access, imessage_read");
      expect(c.text()).toMatch(/imessage\.search\s+ready\s+Read local/);
      expect(c.text()).not.toContain("More text");
      expect(c.text()).toMatch(/imessage\.send\s+needs imessage_automation/);
    });

    it("describes one command with its parameters", async () => {
      const c = capture();
      const f = fakeConnect({ "node.list": nodeList });
      expect(await run(["nodes", "2", "imessage.send"], c.io, f)).toBe(EXIT.ok);
      expect(c.text()).toContain("missing imessage_automation");
      expect(c.text()).toMatch(/REQUIRED\n\s+thread_key \(string\)/);
    });

    it("returns machine-readable command detail with --json", async () => {
      const c = capture();
      const f = fakeConnect({ "node.list": nodeList });
      expect(
        await run(["nodes", "iphone", "location.get", "--json"], c.io, f),
      ).toBe(EXIT.ok);
      expect(JSON.parse(c.text())).toMatchObject({
        command: "location.get",
        missing_permissions: ["location"],
      });
    });

    it("rejects unknown devices and commands", async () => {
      const f = fakeConnect({ "node.list": nodeList });
      expect(await run(["nodes", "watch"], capture().io, f)).toBe(EXIT.usage);
      expect(await run(["nodes", "mac", "shell.run"], capture().io, f)).toBe(
        EXIT.usage,
      );
    });
  });

  it("prints watch events as NDJSON when --json", async () => {
    const c = capture();
    const f = fakeConnect({
      "chat.subscribe": () => [
        {
          type: "event",
          event: "agent.status",
          payload: { activity_text: "thinking" },
        },
        { type: "event", event: "delta.text_append", payload: { text: "hi" } },
      ],
    });
    expect(await run(["watch", "--json", "--events", "delta.*"], c.io, f)).toBe(
      EXIT.ok,
    );
    expect(c.out).toHaveLength(1);
    expect(JSON.parse(c.out[0] as string).event).toBe("delta.text_append");
  });
});
