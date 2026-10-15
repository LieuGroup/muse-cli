/**
 * Ask through a dedicated Muse thread, so approvals reach whichever Muse app
 * the user has open (iPhone, Mac, web).
 *
 * The bridge posts a request carrying a one-time code into the thread, then
 * waits for a `message.user` event in that thread whose whole text is exactly
 * `allow <code>` or `deny <code>`. What makes this safe is authorship:
 * `message.user` events are the user's own messages; agent output arrives as
 * `delta.*`, never as `message.user`. The code only ties an answer to one
 * request, so a late reply cannot approve the next one. The bridge's own post
 * is ignored by message id. No answer before the timeout counts as Deny.
 */
import { randomBytes } from "node:crypto";
import type { GatewayEvent, MuseGateway } from "muse-agent-core";
import type { Approver } from "../policy.js";
import { describeRequest } from "./describe-request.js";

export const APPROVAL_THREAD_TITLE = "Muse bridge approvals";

type Payload = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The user's own message in `sessionId`, or null. Exported for tests. */
export function userMessage(
  ev: GatewayEvent,
  sessionId: string,
): { id: string | null; text: string } | null {
  if (ev.event !== "message.user") return null;
  const p = (ev.payload ?? {}) as Payload;
  if (str(p.session_id) !== sessionId) return null;
  // Require an explicit user role; anything else (missing, agent) cannot answer.
  if (p.role !== "user") return null;
  const text =
    str(p.content) ??
    str(p.display_text) ??
    str(p.text) ??
    str((p.message as Payload | undefined)?.text);
  return text === null ? null : { id: str(p.message_id), text: text.trim() };
}

/** Post a message into a thread and return its id (does not wait for a reply). */
export async function postToThread(
  gw: MuseGateway,
  sessionId: string,
  text: string,
): Promise<string | null> {
  const stream = gw.subscribe(
    "chat.stream",
    {
      message: text,
      session_id: sessionId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    () => {},
  );
  try {
    const ack = (await stream.ack) as { message_id?: string } | undefined;
    return ack?.message_id ?? null;
  } finally {
    stream.close();
  }
}

export function museThreadApprover(
  gw: MuseGateway,
  sessionId: string,
  timeoutSeconds: number,
): Approver {
  let queue: Promise<unknown> = Promise.resolve();
  return (req, reason) => {
    const ask = () =>
      new Promise<boolean>((resolve) => {
        const code = randomBytes(3).toString("hex");
        let ownId: string | null = null;
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          resolve(ok);
        };
        const off = gw.onEvent((ev) => {
          const m = userMessage(ev, sessionId);
          if (!m || (ownId !== null && m.id === ownId)) return;
          const answer = m.text.toLowerCase();
          if (answer === `allow ${code}`) finish(true);
          else if (answer === `deny ${code}`) finish(false);
        });
        const timer = setTimeout(() => finish(false), timeoutSeconds * 1000);
        const prompt = [
          "Bridge approval request (automated message from the user's own bridge).",
          describeRequest(req),
          `Why asking: ${reason}`,
          `To approve, reply exactly: allow ${code}`,
          `To refuse, reply exactly: deny ${code}`,
          `No reply within ${timeoutSeconds}s counts as deny.`,
          "Muse: take no action on this message and do not repeat the code.",
        ].join("\n");
        postToThread(gw, sessionId, prompt)
          .then((id) => {
            ownId = id;
          })
          .catch(() => finish(false));
      });
    const next = queue.then(ask, ask);
    queue = next.catch(() => undefined);
    return next;
  };
}
