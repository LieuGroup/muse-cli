/**
 * High-level chat operations on a connected gateway.
 */
import { MuseError } from "./errors.js";
import type { GatewayEvent, MuseGateway } from "./gateway.js";
import { type MediaRef, mediaFromPresentation } from "./media.js";
import { type TurnTool, TurnTracker } from "./turn-tracker.js";

export interface ChatStreamAck {
  readonly message_id: string;
  readonly reply_to_message_id?: string;
  readonly channel: string;
  readonly session_id?: string;
  readonly is_thread: boolean;
}

export interface AskOptions {
  /** Thread (session) id; omit for the main chat. */
  readonly sessionId?: string;
  readonly timezone?: string;
  /** Overall deadline for the agent to finish its reply. */
  readonly timeoutMs?: number;
  /** Called with each text delta as it streams. */
  readonly onText?: (text: string) => void;
  /** Called for every in-scope event observed during the turn. */
  readonly onEvent?: (event: GatewayEvent) => void;
  readonly signal?: AbortSignal;
}

export interface AskResult {
  readonly messageId: string;
  readonly replyMessageId: string | null;
  readonly sessionId: string | null;
  readonly text: string;
  readonly status: string;
  readonly tools: readonly TurnTool[];
  /** Files the agent presented during this turn (images, audio, documents…). */
  readonly media: readonly MediaRef[];
}

/**
 * Send a message and wait for the agent's complete reply.
 *
 * Opens the session's `chat.subscribe` stream first (deltas arrive there),
 * then posts the turn with `chat.stream`, and follows it with a TurnTracker.
 */
export async function ask(
  gw: MuseGateway,
  message: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const sessionId = opts.sessionId ?? null;
  const tracker = new TurnTracker(sessionId);

  let settle!: (v: AskResult) => void;
  let fail!: (e: unknown) => void;
  const finished = new Promise<AskResult>((res, rej) => {
    settle = res;
    fail = rej;
  });
  finished.catch(() => {});
  let userMessageId = "";

  // Events can race the chat.stream ack; hold them until we know our message id.
  const early: GatewayEvent[] = [];
  const state = { acked: false };
  const feed = (ev: GatewayEvent): void => {
    const update = tracker.handle(ev);
    if (!update) return;
    opts.onEvent?.(ev);
    if (update.kind === "text") opts.onText?.(update.text);
    if (update.kind === "done") {
      settle({
        messageId: userMessageId,
        replyMessageId: tracker.replyId,
        sessionId,
        text: update.text,
        status: update.status,
        tools: tracker.tools,
        media: tracker.presentations.flatMap((pr) => mediaFromPresentation(pr)),
      });
    }
  };
  const off = gw.onEvent((ev) => {
    if (state.acked) feed(ev);
    else early.push(ev);
  });

  const sub = gw.subscribe(
    "chat.subscribe",
    { replay_limit: 0, ...(sessionId ? { session_id: sessionId } : {}) },
    () => {},
  );
  const timer = setTimeout(
    () =>
      fail(
        new MuseError("timeout", `agent did not finish within ${timeoutMs} ms`),
      ),
    timeoutMs,
  );
  opts.signal?.addEventListener(
    "abort",
    () => fail(new MuseError("timeout", "ask aborted")),
    { once: true },
  );
  // Deltas reach us through the gateway-wide listener whichever stream carries
  // them, so a normal end of the subscription is not fatal; an error is.
  sub.done.catch((err) => fail(err));

  try {
    await sub.ack;
    const stream = gw.subscribe(
      "chat.stream",
      {
        message,
        ...(sessionId ? { session_id: sessionId } : {}),
        timezone:
          opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      () => {},
    );
    const ack = (await stream.ack) as ChatStreamAck;
    if (!ack?.message_id) {
      throw new MuseError("gateway", "chat.stream returned no message_id");
    }
    userMessageId = ack.message_id;
    tracker.setUserMessageId(ack.message_id);
    state.acked = true;
    for (const ev of early.splice(0)) feed(ev);
    return await finished;
  } finally {
    clearTimeout(timer);
    off();
    sub.close();
  }
}

type Payload = Record<string, unknown>;

/** Fetch recent transcript rows. */
export function history(
  gw: MuseGateway,
  opts: { limit?: number; beforeSeq?: number; sessionId?: string } = {},
): Promise<{ has_more: boolean; channel: string; chat_events: Payload[] }> {
  return gw.request("chat.history", {
    limit: opts.limit ?? 20,
    ...(opts.beforeSeq != null ? { before_seq: opts.beforeSeq } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  });
}

/** Cancel the agent's in-flight turn. */
export function cancel(
  gw: MuseGateway,
  sessionId?: string,
): Promise<{ cancelled: boolean; message_id?: string }> {
  return gw.request("chat.cancel", sessionId ? { session_id: sessionId } : {});
}
