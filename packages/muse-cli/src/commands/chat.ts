import { createInterface } from "node:readline/promises";
import { ask, cancel, type GatewayEvent, history } from "muse-agent-core";
import {
  type Command,
  type CommandContext,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber, flagString } from "../parse-argv.js";
import { bold, cyan, dim, relativeTime, truncate } from "../render.js";
import { saveMediaRefs } from "./media.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function messageFrom(ctx: CommandContext): Promise<string> {
  const fromArgs = ctx.args.positionals.join(" ").trim();
  if (fromArgs && fromArgs !== "-") return fromArgs;
  if (fromArgs === "-" || !process.stdin.isTTY) {
    return (await readStdin()).trim();
  }
  return "";
}

function statusLine(ev: GatewayEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  if (ev.event === "delta.tool_start") {
    return `▸ ${String(p.tool_name ?? p.name ?? "tool")}`;
  }
  if (ev.event === "agent.status" && typeof p.activity_text === "string") {
    return `… ${p.activity_text}`;
  }
  return null;
}

export const askCommand: Command = async (ctx) => {
  const message = await messageFrom(ctx);
  if (!message) {
    usageError(
      'usage: muse ask "message" [--thread ID] [--timeout SEC] [--quiet]',
    );
  }
  const timeoutSec = flagNumber(ctx.args.flags, "timeout") ?? 300;
  const quiet = ctx.args.flags.quiet === true;
  const showStatus = !ctx.json && !quiet && process.stderr.isTTY === true;
  return withGateway(ctx, async ({ gateway }) => {
    const result = await ask(gateway, message, {
      sessionId: flagString(ctx.args.flags, "thread"),
      timeoutMs: timeoutSec * 1000,
      onText: ctx.json ? undefined : (t) => ctx.io.write(t),
      onEvent: showStatus
        ? (ev) => {
            const line = statusLine(ev);
            if (line) process.stderr.write(`${dim(line)}\n`);
          }
        : undefined,
    });
    const saveDir = flagString(ctx.args.flags, "save-media");
    const log = (l: string) =>
      ctx.json ? process.stderr.write(`${l}\n`) : ctx.io.out(dim(l));
    if (!ctx.json) ctx.io.write("\n");
    if (saveDir && result.media.length > 0) {
      await saveMediaRefs(gateway, result.media, saveDir, log);
    } else if (!ctx.json && result.media.length > 0) {
      for (const m of result.media)
        log(`${m.kind}: ${m.path}  (download with --save-media DIR)`);
    }
    if (ctx.json) printJson(ctx, result);
    return EXIT.ok;
  });
};

export const chatCommand: Command = async (ctx) => {
  const thread = flagString(ctx.args.flags, "thread");
  return withGateway(ctx, async ({ gateway, vm }) => {
    ctx.io.out(
      dim(
        `Connected to ${vm.vmName ?? vm.vmId ?? "your agent"}. Type a message, /exit to quit, /cancel to stop a reply.`,
      ),
    );
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      for (;;) {
        let line: string;
        try {
          line = (await rl.question(cyan("you › "))).trim();
        } catch {
          break; // stdin closed
        }
        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;
        if (line === "/cancel") {
          printJson(ctx, await cancel(gateway, thread));
          continue;
        }
        ctx.io.write(bold("muse › "));
        try {
          await ask(gateway, line, {
            sessionId: thread,
            timeoutMs: 600_000,
            onText: (t) => ctx.io.write(t),
          });
        } catch (err) {
          ctx.io.err(`\nmuse: ${(err as Error).message}`);
        }
        ctx.io.write("\n");
      }
    } finally {
      rl.close();
    }
    return EXIT.ok;
  });
};

export const historyCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway }) => {
    const res = await history(gateway, {
      limit: flagNumber(ctx.args.flags, "limit") ?? 20,
      sessionId: flagString(ctx.args.flags, "thread"),
    });
    if (ctx.json) {
      printJson(ctx, res);
      return EXIT.ok;
    }
    for (const row of res.chat_events) {
      const text = String(row.display_text ?? "").trim();
      if (!text) continue;
      const who =
        row.event_name === "message.user" ? cyan("you ") : bold("muse");
      const when = dim(relativeTime(Number(row.occurred_at_ms)));
      ctx.io.out(`${who} ${when}\n${text}\n`);
    }
    return EXIT.ok;
  });

export const cancelCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway }) => {
    const res = await cancel(gateway, flagString(ctx.args.flags, "thread"));
    if (ctx.json) printJson(ctx, res);
    else
      ctx.io.out(
        res.cancelled ? "Cancelled the running reply." : "Nothing was running.",
      );
    return EXIT.ok;
  });

/** Stream every live event as NDJSON until interrupted (or --seconds). */
export const watchCommand: Command = async (ctx) => {
  const seconds = flagNumber(ctx.args.flags, "seconds");
  const filter = flagString(ctx.args.flags, "events")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return withGateway(ctx, async ({ gateway }) => {
    const matches = (name: string) =>
      !filter ||
      filter.some((f) =>
        f.endsWith("*") ? name.startsWith(f.slice(0, -1)) : name === f,
      );
    const sub = gateway.subscribe(
      "chat.subscribe",
      {
        replay_limit: 0,
        ...(flagString(ctx.args.flags, "thread")
          ? { session_id: flagString(ctx.args.flags, "thread") }
          : {}),
      },
      (ev) => {
        if (!matches(ev.event)) return;
        if (ctx.json || !process.stdout.isTTY) {
          ctx.io.out(JSON.stringify(ev));
          return;
        }
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        if (ev.event === "delta.text_append" && typeof p.text === "string") {
          ctx.io.write(p.text);
        } else if (ev.event === "delta.message_done") {
          ctx.io.write("\n");
        } else {
          ctx.io.out(dim(`[${ev.event}] ${truncate(JSON.stringify(p), 140)}`));
        }
      },
    );
    await sub.ack;
    if (!ctx.json && process.stdout.isTTY) {
      process.stderr.write(dim("Watching live events. Ctrl-C to stop.\n"));
    }
    const stop = new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      if (seconds) setTimeout(resolve, seconds * 1000);
    });
    await Promise.race([sub.done, stop]);
    sub.close();
    return EXIT.ok;
  });
};
