import { randomUUID } from "node:crypto";
import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { bold, dim, relativeTime, table, truncate } from "../render.js";

interface SessionItem {
  session_id: string;
  title?: string;
  snippet?: string;
  is_primary?: boolean;
  is_thread?: boolean;
  pinned?: boolean;
  archived?: boolean;
  unread_count?: number;
  updated_at_ms?: number;
}

/** `muse threads [list|new|rename|archive|unarchive]` */
export const threadsCommand: Command = async (ctx) => {
  const [sub = "list", id, ...rest] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    switch (sub) {
      case "list": {
        const res = (await gateway.request("sessions.list", {
          ...(ctx.args.flags.archived === true ? { view: "archived" } : {}),
        })) as { sessions: SessionItem[] };
        if (ctx.json) {
          printJson(ctx, res.sessions);
          return EXIT.ok;
        }
        ctx.io.out(
          table(
            ["ID", "TITLE", "UPDATED", "UNREAD", ""],
            res.sessions.map((s) => [
              s.session_id,
              truncate(s.title || s.snippet || "(untitled)", 48),
              relativeTime(s.updated_at_ms),
              String(s.unread_count ?? 0),
              [s.is_primary ? "main" : "", s.pinned ? "pinned" : ""]
                .filter(Boolean)
                .join(","),
            ]),
          ),
        );
        return EXIT.ok;
      }
      case "new": {
        const sessionId = randomUUID();
        await gateway.request("session.start", {
          method: "/api/session/start",
          session_id: sessionId,
          params: { origin: "fresh", lifecycle: "persistent" },
        });
        const title = [id, ...rest].filter(Boolean).join(" ").trim();
        if (title)
          await gateway.request("session.rename", {
            session_id: sessionId,
            title,
          });
        if (ctx.json)
          printJson(ctx, { session_id: sessionId, title: title || null });
        else {
          ctx.io.out(`${bold("Created thread")} ${sessionId}`);
          ctx.io.out(dim(`Use it: muse ask "…" --thread ${sessionId}`));
        }
        return EXIT.ok;
      }
      case "rename": {
        const title = rest.join(" ").trim();
        if (!id || !title)
          usageError("usage: muse threads rename <id> <title>");
        printJson(
          ctx,
          await gateway.request("session.rename", { session_id: id, title }),
        );
        return EXIT.ok;
      }
      case "archive":
      case "unarchive": {
        if (!id) usageError(`usage: muse threads ${sub} <id>`);
        printJson(
          ctx,
          await gateway.request(`session.${sub}`, {
            method: `/api/session/${sub}`,
            session_id: id,
          }),
        );
        return EXIT.ok;
      }
      default:
        usageError(
          "usage: muse threads [list|new [title]|rename <id> <title>|archive <id>|unarchive <id>]",
        );
    }
  });
};
