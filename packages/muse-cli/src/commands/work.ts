import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber, flagString } from "../parse-argv.js";
import {
  bold,
  dim,
  green,
  red,
  relativeTime,
  table,
  toEpochMs,
  truncate,
  yellow,
} from "../render.js";

interface Schedule {
  id: string;
  title: string | null;
  path: string;
  mode: string;
  enabled: boolean;
  is_heartbeat: boolean;
  next_run_at_utc: number | null;
  timezone: string;
  cadence: {
    kind: string;
    interval_seconds?: number;
    run_at_utc?: number;
    expr?: string;
  };
}

interface TaskRun {
  run_id: string;
  status: string;
  scheduled_for_utc: number;
  trigger_reason: string;
  result_summary?: string | null;
  error_text?: string | null;
}

function cadenceText(c: Schedule["cadence"]): string {
  if (c.kind === "interval" && c.interval_seconds) {
    const s = c.interval_seconds;
    if (s % 3600 === 0) return `every ${s / 3600}h`;
    if (s % 60 === 0) return `every ${s / 60}m`;
    return `every ${s}s`;
  }
  if (c.kind === "runonce") return "once";
  return c.expr ?? c.kind;
}

function taskName(t: Schedule): string {
  if (t.title) return t.title;
  if (t.is_heartbeat) return "heartbeat";
  const parts = t.path.split("/");
  const goalIdx = parts.indexOf("goals");
  if (goalIdx >= 0 && parts[goalIdx + 1]) return parts[goalIdx + 1] as string;
  return parts.at(-1) ?? t.id;
}

function statusColor(status: string): string {
  if (/success|completed|ok|done/i.test(status)) return green(status);
  if (/fail|error/i.test(status)) return red(status);
  return yellow(status);
}

/** `muse tasks [runs <id>|run <id>]` — scheduled tasks. */
export const tasksCommand: Command = async (ctx) => {
  const [sub, id] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    if (sub === "run") {
      if (!id) usageError("usage: muse tasks run <task-id> [--reason text]");
      const reason = flagString(ctx.args.flags, "reason");
      const res = await gateway.request("tasks.run", {
        job_id: id,
        ...(reason ? { reason } : {}),
      });
      if (ctx.json) printJson(ctx, res);
      else ctx.io.out(`Queued a run of ${bold(id)}.`);
      return EXIT.ok;
    }
    if (sub === "runs") {
      if (!id) usageError("usage: muse tasks runs <task-id> [--limit N]");
      const res = (await gateway.request("tasks.runs", {
        job_id: id,
        limit: flagNumber(ctx.args.flags, "limit") ?? 10,
      })) as { runs: TaskRun[] };
      if (ctx.json) {
        printJson(ctx, res.runs);
        return EXIT.ok;
      }
      ctx.io.out(
        table(
          ["WHEN", "STATUS", "TRIGGER", "RESULT"],
          res.runs.map((r) => [
            relativeTime(toEpochMs(r.scheduled_for_utc)),
            statusColor(r.status),
            r.trigger_reason,
            truncate(r.error_text ?? r.result_summary ?? "", 70),
          ]),
        ),
      );
      return EXIT.ok;
    }
    if (sub) usageError("usage: muse tasks [run <id> | runs <id>]");
    const res = (await gateway.request("tasks.list")) as {
      schedules: Schedule[];
    };
    if (ctx.json) {
      printJson(ctx, res.schedules);
      return EXIT.ok;
    }
    ctx.io.out(
      table(
        ["ID", "TASK", "CADENCE", "NEXT RUN", "STATE"],
        res.schedules.map((t) => [
          t.id,
          truncate(taskName(t), 40),
          cadenceText(t.cadence),
          relativeTime(toEpochMs(t.next_run_at_utc)),
          t.enabled ? "on" : dim("paused"),
        ]),
      ),
    );
    ctx.io.out(
      dim(
        "\nCreate or change schedules by asking Muse; run one now with `muse tasks run <id>`.",
      ),
    );
    return EXIT.ok;
  });
};

interface Goal {
  goal_id: string;
  slug: string;
  title: string;
  status: string;
  summary?: string;
  momentum?: string;
  last_activity_at?: string;
}

/** `muse goals [<id>]` */
export const goalsCommand: Command = async (ctx) => {
  const [id] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    if (id) {
      printJson(ctx, await gateway.request("goals.get", { id }));
      return EXIT.ok;
    }
    const res = (await gateway.request("goals.list")) as { goals: Goal[] };
    if (ctx.json) {
      printJson(ctx, res.goals);
      return EXIT.ok;
    }
    ctx.io.out(
      table(
        ["ID", "GOAL", "STATUS", "MOMENTUM", "ACTIVE"],
        res.goals.map((g) => [
          g.goal_id,
          truncate(g.title, 46),
          g.status,
          g.momentum ?? "-",
          g.last_activity_at
            ? relativeTime(toEpochMs(g.last_activity_at))
            : "-",
        ]),
      ),
    );
    return EXIT.ok;
  });
};

interface MemoryHit {
  memory_uri: string;
  text: string;
  scores?: Record<string, number>;
}

/** `muse memory "<query>" [--limit N]` */
export const memoryCommand: Command = async (ctx) => {
  const query = ctx.args.positionals.join(" ").trim();
  if (!query) usageError('usage: muse memory "what to search for" [--limit N]');
  const limit = flagNumber(ctx.args.flags, "limit") ?? 8;
  return withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("memory.search", {
      query,
      top_k: limit,
      limit,
    })) as { hits: MemoryHit[] };
    if (ctx.json) {
      printJson(ctx, res.hits);
      return EXIT.ok;
    }
    if (res.hits.length === 0) ctx.io.out("No memories matched.");
    for (const h of res.hits) {
      ctx.io.out(`${dim(h.memory_uri)}\n${truncate(h.text, 400)}\n`);
    }
    return EXIT.ok;
  });
};

interface Activity {
  timestamp?: string;
  type: string;
  title?: string;
  subtitle?: string;
  status?: string;
}

/** `muse activity [--limit N]` — what the agent has been doing. */
export const activityCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("activity.list", {
      limit: flagNumber(ctx.args.flags, "limit") ?? 20,
    })) as { days: { date: string; activities: Activity[] }[] };
    if (ctx.json) {
      printJson(ctx, res.days);
      return EXIT.ok;
    }
    for (const day of res.days) {
      ctx.io.out(bold(day.date));
      for (const a of day.activities) {
        const when = a.timestamp ? relativeTime(toEpochMs(a.timestamp)) : "";
        ctx.io.out(
          `  ${dim(when.padEnd(9))} ${a.type.padEnd(16)} ${truncate(a.title ?? a.subtitle ?? "", 70)}`,
        );
      }
    }
    return EXIT.ok;
  });

interface Subagent {
  agent_id: string;
  status: string;
  created_at: string;
  completed_at?: string;
  prompt: string;
}

/** `muse subagents` — recent and active sub-agents. */
export const subagentsCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("subagents.list")) as {
      active: Subagent[];
      recent: Subagent[];
    };
    if (ctx.json) {
      printJson(ctx, res);
      return EXIT.ok;
    }
    const rows = [...res.active, ...res.recent];
    ctx.io.out(
      table(
        ["STARTED", "STATUS", "PROMPT"],
        rows.map((s) => [
          relativeTime(toEpochMs(s.created_at)),
          statusColor(s.status),
          truncate(s.prompt, 90),
        ]),
      ),
    );
    ctx.io.out(
      dim(`\n${res.active.length} active, ${res.recent.length} recent`),
    );
    return EXIT.ok;
  });
