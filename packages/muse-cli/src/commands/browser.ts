import { execFile } from "node:child_process";
import { startVncBridge, toVmPath } from "muse-agent-core";
import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber, flagString } from "../parse-argv.js";
import { bold, dim, green, table, truncate, yellow } from "../render.js";
import { saveVmFile } from "./media.js";

interface BrowserTask {
  browser_task_id: string;
  title?: string;
  status?: string;
  control_owner?: string;
  activity_title?: string;
  step_count?: number;
  current_site?: { url?: string; page_title?: string };
  latest_screenshot?: { url?: string };
}

type Request = (m: string, p: Record<string, unknown>) => Promise<unknown>;

async function listTasks(request: Request): Promise<BrowserTask[]> {
  const ctx = (await request("computer.context", {})) as {
    tasks?: BrowserTask[];
  };
  return ctx.tasks ?? [];
}

function pickTask(
  tasks: BrowserTask[],
  key: string | undefined,
): BrowserTask | undefined {
  if (!key) return tasks[0];
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1) return tasks[n - 1];
  return tasks.find(
    (t) => t.browser_task_id === key || t.browser_task_id.endsWith(key),
  );
}

function waitForSignal(seconds?: number): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    if (seconds) setTimeout(resolve, seconds * 1000);
  });
}

/**
 * `muse browser [list]`                 running browser tasks
 * `muse browser shot [#|id] [dir]`      download the latest screenshot
 * `muse browser vnc [#|id] [--port N] [--open]`  local VNC bridge (view)
 * `muse browser takeover|release|stop [#|id]`     control the session
 */
export const browserCommand: Command = async (ctx) => {
  const [sub = "list", key, dest] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    const request: Request = (m, p) => gateway.request(m, p);
    const tasks = await listTasks(request);

    if (sub === "list") {
      if (ctx.json) {
        printJson(ctx, tasks);
        return EXIT.ok;
      }
      if (tasks.length === 0) {
        ctx.io.out(
          'No browser is running. Ask Muse to use its browser, e.g. muse ask "open example.com in your browser".',
        );
        return EXIT.ok;
      }
      const rows = tasks.map((t, i) => [
        String(i + 1),
        t.status ?? "?",
        t.control_owner === "user" ? yellow("you") : (t.control_owner ?? "?"),
        truncate(t.current_site?.url ?? "-", 48),
        truncate(t.activity_title ?? t.title ?? "", 40),
      ]);
      ctx.io.out(table(["#", "STATUS", "CONTROL", "URL", "ACTIVITY"], rows));
      ctx.io.out(
        dim(
          "\nView live: muse browser vnc   ·   Screenshot: muse browser shot",
        ),
      );
      return EXIT.ok;
    }

    const task = pickTask(tasks, key);
    if (!task)
      usageError("No matching browser task. Run `muse browser` to list them.");
    const taskId = task.browser_task_id;

    switch (sub) {
      case "shot": {
        const url = task.latest_screenshot?.url;
        if (!url) usageError("This browser task has no screenshot yet.");
        const r = await saveVmFile(gateway, toVmPath(url), dest ?? ".");
        ctx.io.out(`Saved screenshot -> ${r.local}`);
        return EXIT.ok;
      }
      case "takeover":
      case "release":
      case "stop": {
        const res = await gateway.request(`browser_task.${sub}`, {
          task_id: taskId,
        });
        if (ctx.json) printJson(ctx, res);
        else ctx.io.out(`${sub} sent for ${taskId}`);
        return EXIT.ok;
      }
      case "vnc": {
        const port = flagNumber(ctx.args.flags, "port") ?? 5900;
        const bridge = await startVncBridge(gateway, {
          taskId,
          port,
          host: flagString(ctx.args.flags, "host") ?? "127.0.0.1",
          log: (l) => ctx.io.err(dim(`[vnc] ${l}`)),
        });
        const url = `vnc://${bridge.host}:${bridge.port}`;
        ctx.io.out(
          `${green("VNC bridge ready")} ${bold(url)}  (no password; local only)`,
        );
        ctx.io.out(
          dim(
            `Browser: ${task.current_site?.url ?? "-"} · control: ${task.control_owner ?? "?"}`,
          ),
        );
        ctx.io.out(
          dim(
            "Viewing only. To type/click yourself: muse browser takeover (then release).",
          ),
        );
        if (ctx.args.flags.open === true && process.platform === "darwin") {
          execFile("open", [url]);
        }
        await waitForSignal(flagNumber(ctx.args.flags, "seconds"));
        await bridge.close();
        return EXIT.ok;
      }
      default:
        usageError(
          "usage: muse browser [list|shot|vnc|takeover|release|stop] [#|task-id]",
        );
    }
  });
};
