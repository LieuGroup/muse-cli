/**
 * End-to-end test against an in-process fake VM that speaks the real wire
 * protocol: Noise XX responder + HTTP-over-Noise envelope + NDJSON streams.
 */
import { describe, expect, it } from "vitest";
import { ask } from "./chat.js";
import { MuseGateway } from "./gateway.js";
import { encodeNoiseFrames, NoiseFrameDecoder } from "./noise/framer.js";
import { type CipherState, NoiseXXResponder } from "./noise/noise-xx.js";
import {
  fieldBytes,
  fieldString,
  ProtoWriter,
  readProtoFields,
} from "./noise/protobuf.js";

const EMPTY = new Uint8Array(0);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

interface SeenRequest {
  verb: string;
  path: string;
  body: string;
}

type Route = (req: SeenRequest) => { status: number; chunks: string[] };

/** Fake WebSocket that plays the VM side of the protocol. */
class FakeVmSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly requests: SeenRequest[] = [];
  private readonly responder = new NoiseXXResponder(
    enc("standard-attestation"),
  );
  private stage: "msg1" | "msg3" | "transport" = "msg1";
  private sendCipher: CipherState | null = null;
  private recvCipher: CipherState | null = null;
  private readonly frames = new NoiseFrameDecoder();

  constructor(private readonly route: Route) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  private deliver(bytes: Uint8Array): void {
    const copy = bytes.slice();
    queueMicrotask(() => this.onmessage?.({ data: copy.buffer }));
  }

  private emit(streamId: bigint, kind: 3 | 4, inner: Uint8Array): void {
    const frame = new ProtoWriter()
      .varint(1, streamId)
      .message(kind, inner)
      .finish();
    const svc = new ProtoWriter().bytes(1, frame).finish();
    for (const chunk of encodeNoiseFrames(svc)) {
      this.deliver(
        (this.sendCipher as CipherState).encryptWithAd(EMPTY, chunk),
      );
    }
  }

  private reply(streamId: bigint, status: number, chunks: string[]): void {
    const [first = "", ...rest] = chunks;
    const head = new ProtoWriter()
      .varint(1, status)
      .message(
        2,
        new ProtoWriter()
          .string(1, "content-type")
          .string(2, "application/json")
          .finish(),
      )
      .bytes(3, enc(first))
      .varint(4, rest.length === 0)
      .finish();
    this.emit(streamId, 3, head);
    rest.forEach((text, i) => {
      const body = new ProtoWriter()
        .bytes(1, enc(text))
        .varint(2, i === rest.length - 1)
        .finish();
      this.emit(streamId, 4, body);
    });
  }

  send(data: Uint8Array): void {
    if (this.stage === "msg1") {
      this.deliver(this.responder.readMessage1WriteMessage2(data));
      this.stage = "msg3";
      return;
    }
    if (this.stage === "msg3") {
      this.responder.readMessage3(data);
      const [send, recv] = this.responder.split();
      this.sendCipher = send;
      this.recvCipher = recv;
      this.stage = "transport";
      return;
    }
    const plain = (this.recvCipher as CipherState).decryptWithAd(EMPTY, data);
    const whole = this.frames.decode(plain);
    if (!whole) return;
    const outer = readProtoFields(whole);
    const frame = readProtoFields(fieldBytes(outer, 2) as Uint8Array);
    const streamId = BigInt(frame.find((f) => f.field === 1)?.value as bigint);
    const reqBytes = fieldBytes(frame, 2);
    if (!reqBytes) return; // reset / body chunk from client: ignore
    const req = readProtoFields(reqBytes);
    const seen = {
      verb: fieldString(req, 1) ?? "",
      path: fieldString(req, 2) ?? "",
      body: dec(fieldBytes(req, 4) ?? EMPTY),
    };
    this.requests.push(seen);
    const { status, chunks } = this.route(seen);
    this.reply(streamId, status, chunks);
  }

  close(): void {
    this.readyState = 3;
  }
}

function connectFake(route: Route) {
  let socket!: FakeVmSocket;
  const gw = MuseGateway.connect({
    gatewayUrl: "https://3f2a0b1c-1111-4222-8333-944455556666.metaaivm.com",
    credentials: { token: "test-token", notaryToken: null },
    wsFactory: () => {
      socket = new FakeVmSocket(route);
      return socket as unknown as WebSocket;
    },
  });
  return gw.then((g) => ({ gw: g, socket }));
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe("MuseGateway over a fake VM", () => {
  it("handshakes and performs a JSON request", async () => {
    const { gw, socket } = await connectFake(({ path }) =>
      path.startsWith("/model")
        ? {
            status: 200,
            chunks: [
              JSON.stringify({
                selected_model: "m1",
                default_model: "m1",
                available_models: [],
                generation: 1,
              }),
            ],
          }
        : {
            status: 404,
            chunks: [
              JSON.stringify({ error: { code: "not_found", message: "nope" } }),
            ],
          },
    );
    const model = await gw.request<{ selected_model: string }>("model.get");
    expect(model.selected_model).toBe("m1");
    expect(socket.requests[0]).toMatchObject({ verb: "GET", path: "/model" });
    await expect(gw.request("sessions.list")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    gw.close();
  });

  it("fills path params and sends GET params as a query string", async () => {
    const { gw, socket } = await connectFake(() => ({
      status: 200,
      chunks: ['{"ok":true,"result":{"id":"s1"}}'],
    }));
    const out = await gw.request("sessions.get", { id: "abc/def" });
    expect(out).toEqual({ id: "s1" });
    expect(socket.requests[0]?.path).toBe("/api/session/list/abc%2Fdef");
    await gw.request("chat.history", { limit: 5, session_id: "x" });
    expect(socket.requests[1]?.path).toBe("/chat/history?limit=5&session_id=x");
    gw.close();
  });

  it("runs a full ask() turn from NDJSON deltas", async () => {
    // Mirrors the observed live protocol: reply_to_message_id is empty, the
    // user turn is echoed as message.user, and the reply is the next
    // main-lane delta.message_start in the same session.
    const S = { session_id: "t1", is_thread: true, transcript_surface: "main" };
    const ev = (event: string, payload: Record<string, unknown>) =>
      line({ type: "event", event, payload: { ...S, ...payload } });
    const { gw, socket } = await connectFake(({ path }) => {
      if (path === "/chat/subscribe") {
        return {
          status: 200,
          chunks: [
            line({
              ok: true,
              result: { subscribed: true, agent_id: "a", conn_id: "c" },
            }),
          ],
        };
      }
      if (path === "/chat/stream") {
        return {
          status: 200,
          chunks: [
            line({
              ok: true,
              result: {
                message_id: "u1",
                channel: "main",
                is_thread: true,
                session_id: "t1",
              },
            }),
            // A reply from another session must be ignored.
            ev("delta.message_start", {
              session_id: "other",
              message_id: "x1",
            }),
            ev("message.user", { message_id: "u1" }),
            ev("delta.message_start", {
              message_id: "r1",
              reply_to_message_id: "",
            }),
            ev("delta.text_append", { message_id: "r1", text: "Hello " }),
            ev("delta.tool_start", { message_id: "r1", tool_name: "search" }),
            ev("delta.text_append", { message_id: "r1", text: "world" }),
            ev("delta.message_done", {
              message_id: "r1",
              status: "completed",
              transcript: {
                messages: [
                  {
                    id: "r1",
                    role: "assistant",
                    content: [{ type: "text", text: "Hello world!" }],
                  },
                ],
              },
            }),
          ],
        };
      }
      return { status: 404, chunks: ["{}"] };
    });
    const streamed: string[] = [];
    const result = await ask(gw, "hi", {
      sessionId: "t1",
      onText: (t) => streamed.push(t),
      timeoutMs: 5_000,
    });
    // Final transcript text wins over the accumulated deltas.
    expect(result.text).toBe("Hello world!");
    expect(streamed.join("")).toBe("Hello world");
    expect(result.replyMessageId).toBe("r1");
    expect(result.status).toBe("completed");
    expect(result.tools).toEqual([{ name: "search", status: "started" }]);
    expect(
      JSON.parse(
        socket.requests.find((r) => r.path === "/chat/stream")?.body ?? "{}",
      ),
    ).toMatchObject({ message: "hi", session_id: "t1" });
    gw.close();
  });
});
