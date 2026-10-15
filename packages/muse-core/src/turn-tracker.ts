/**
 * Follows one chat turn through the live event stream.
 *
 * Observed protocol (Oct 2026): the reply's `reply_to_message_id` is empty, so
 * a reply cannot be matched to the user message by id. Instead:
 *   1. events are scoped to the session (main chat or a thread);
 *   2. the server echoes our turn as `message.user` with our `message_id`;
 *   3. the first main-lane `delta.message_start` after that echo is the reply;
 *   4. `delta.*` with that reply's `message_id` stream text and tool calls;
 *   5. `delta.message_done` for it ends the turn, carrying a final transcript.
 */
import type { GatewayEvent } from "./gateway.js";

type Payload = Record<string, unknown>;

export interface TurnTool {
  readonly name: string;
  readonly status: "started" | "done";
}

export type TurnUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: TurnTool }
  | { kind: "status"; activity: string; text: string }
  | { kind: "presentation"; payload: Record<string, unknown> }
  | { kind: "done"; text: string; status: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isMainLane(p: Payload): boolean {
  const lane = p.stream_lane;
  const surface = p.transcript_surface;
  if (lane == null && surface == null) return true;
  return lane === "main" || surface === "main" || surface === "main_chat";
}

/** Concatenate assistant text from a `delta.message_done` transcript. */
export function transcriptText(
  p: Payload,
  replyId: string | null,
): string | null {
  const transcript = (p.transcript ?? null) as { messages?: unknown[] } | null;
  if (!transcript || !Array.isArray(transcript.messages)) return null;
  const messages = transcript.messages as {
    id?: string;
    role?: string;
    content?: { type?: string; text?: string }[];
  }[];
  const assistants = messages.filter((m) => m.role === "assistant");
  const target =
    (replyId ? assistants.find((m) => m.id === replyId) : undefined) ??
    assistants.at(-1);
  if (!target || !Array.isArray(target.content)) return null;
  const text = target.content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text.length > 0 ? text : null;
}

export class TurnTracker {
  #userMessageId: string | null = null;
  #sawUserEcho = false;
  #replyId: string | null = null;
  #text = "";
  readonly tools: TurnTool[] = [];
  /** `delta.presentation` payloads (images, audio, files…) seen this turn. */
  readonly presentations: Record<string, unknown>[] = [];

  constructor(readonly sessionId: string | null) {}

  get replyId(): string | null {
    return this.#replyId;
  }

  get text(): string {
    return this.#text;
  }

  /** Set once the `chat.stream` ack returns our user message id. */
  setUserMessageId(id: string): void {
    this.#userMessageId = id;
  }

  #inScope(p: Payload): boolean {
    const sid = str(p.session_id);
    if (this.sessionId) return sid === this.sessionId;
    // Main chat: events either carry no session or are not a thread.
    return p.is_thread !== true;
  }

  /** Feed one event; returns what it meant for this turn, if anything. */
  handle(ev: GatewayEvent): TurnUpdate | null {
    const p = (ev.payload ?? {}) as Payload;
    if (!this.#inScope(p)) return null;

    if (ev.event === "message.user") {
      if (this.#userMessageId && str(p.message_id) === this.#userMessageId) {
        this.#sawUserEcho = true;
      }
      return null;
    }
    if (ev.event === "agent.status") {
      return {
        kind: "status",
        activity: str(p.activity_code) ?? "",
        text: str(p.activity_text) ?? "",
      };
    }
    if (ev.event === "delta.presentation") {
      // Presentations carry their own message id; attribute every one that
      // arrives in this session after our user message was echoed.
      if (!this.#sawUserEcho && !this.#replyId) return null;
      this.presentations.push(p);
      return { kind: "presentation", payload: p };
    }
    if (!ev.event.startsWith("delta.") || !isMainLane(p)) return null;

    const messageId = str(p.message_id);
    if (ev.event === "delta.message_start" && !this.#replyId) {
      // Our echo may race the ack; accept the first reply once we know our id.
      if (this.#sawUserEcho || this.#userMessageId) this.#replyId = messageId;
      return null;
    }
    if (!this.#replyId || messageId !== this.#replyId) return null;

    switch (ev.event) {
      case "delta.text_append": {
        const t = typeof p.text === "string" ? p.text : "";
        if (!t) return null;
        this.#text += t;
        return { kind: "text", text: t };
      }
      case "delta.tool_start":
      case "delta.tool_done": {
        const tool: TurnTool = {
          name: str(p.tool_name) ?? str(p.name) ?? "tool",
          status: ev.event === "delta.tool_start" ? "started" : "done",
        };
        this.tools.push(tool);
        return { kind: "tool", tool };
      }
      case "delta.message_done": {
        const finalText = transcriptText(p, this.#replyId);
        if (finalText && finalText.length >= this.#text.length) {
          this.#text = finalText;
        }
        return {
          kind: "done",
          text: this.#text,
          status: str(p.status) ?? "completed",
        };
      }
      default:
        return null;
    }
  }
}
