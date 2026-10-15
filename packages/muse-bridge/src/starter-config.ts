/**
 * The config `muse bridge init` writes. Safe by default: only a read-only
 * `full` command is enabled; Claude Code is present but `manual`, and the
 * examples for LilOS (http) and Grokbot (mcp) are disabled.
 */
import { hostname } from "node:os";
import type { ApprovalChannel } from "./config.js";

export function starterConfig(
  channel: ApprovalChannel,
  repoRoot: string,
): Record<string, unknown> {
  const machine = hostname().replace(/\.local$/, "");
  return {
    display_name: `Muse bridge (${machine})`,
    approval: { channel, timeout_seconds: 25 },
    runtimes: {
      shell: {
        enabled: true,
        commands: {
          "bridge.uptime": {
            level: "full",
            options: {
              argv: ["uptime"],
              description:
                "Show how long this machine has been up and its load.",
            },
          },
        },
      },
      "claude-code": {
        enabled: true,
        options: { permission_mode: "plan", max_budget_usd: 2 },
        commands: {
          "claude.ask": {
            level: "manual",
            rules: {
              cwd_allow: [repoRoot],
              per_hour: 5,
              max_concurrent: 1,
              max_seconds: 900,
            },
          },
        },
      },
      lilos: {
        enabled: false,
        options: {
          kind: "http",
          headers: { Authorization: "env:LILOS_TOKEN" },
        },
        commands: {
          "lilos.run_task": {
            level: "manual",
            options: {
              url: "http://127.0.0.1:7777/tasks/run",
              description: "Run a LilOS task by id.",
              params: { task: "Task id" },
            },
          },
        },
      },
      grokbot: {
        enabled: false,
        options: { kind: "mcp", command: "grokbot-mcp", args: [] },
        commands: { "grokbot.ask": { level: "manual" } },
      },
    },
  };
}
