/**
 * Gateway client: one Noise-encrypted WebSocket to a user's agent VM, over
 * which logical HTTP requests are multiplexed by stream id.
 */
import { randomUUID } from "node:crypto";
import { buildNoiseWsUrl, DEFAULT_APP_ID } from "./config.js";
import { GatewayRequestError, MuseError } from "./errors.js";
import type { DecodedFrame, Header } from "./noise/envelope.js";
import {
  classifyMessage2,
  createClientNonce,
  encodeMessage1Payload,
} from "./noise/handshake-payloads.js";
import { NoiseXXInitiator } from "./noise/noise-xx.js";
import { NoiseTransport } from "./noise/transport.js";
import {
  appendQuery,
  findRoute,
  type NoiseService,
  type RpcRouteSpec,
  resolveRoutePath,
} from "./rpc-catalog.js";
import type { VmCredentials } from "./session.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_HANDSHAKE_MESSAGE = 65_535;

/** One NDJSON envelope delivered on a subscription stream. */
export interface GatewayEvent {
  readonly type: "event";
  readonly event: string;
  readonly payload: unknown;
  readonly seq?: number;
  readonly ts_ms?: number;
}

export interface ConnectOptions {
  readonly gatewayUrl: string;
  readonly vmName?: string | null;
  readonly credentials: VmCredentials;
  readonly appId?: string;
  readonly acceptLanguage?: string;
  readonly signal?: AbortSignal;
  /** Override for tests. */
  readonly wsFactory?: (url: string) => WebSocket;
}

interface Pending {
  readonly method: string;
  readonly service: NoiseService;
  readonly route: RpcRouteSpec;
  /** Resolve with raw bytes instead of parsing JSON. */
  readonly binary?: boolean;
  status: number;
  headers: Header[];
  readonly body: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve(value: unknown): void;
  reject(err: unknown): void;
  /** Present for subscription streams. */
  stream?: {
    acked: boolean;
    pendingText: string;
    readonly decoder: TextDecoder;
    readonly onEvent: (event: GatewayEvent) => void;
    readonly onEnd: (err?: unknown) => void;
  };
}

/** A raw bidirectional byte stream over one Noise request stream. */
export interface DuplexStream {
  readonly opened: boolean;
  send(bytes: Uint8Array): void;
  close(): void;
}

/** A binary response body plus its content type. */
export interface BinaryResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

function binaryResult(
  status: number,
  headers: Header[],
  parts: Uint8Array[],
): BinaryResult {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
  }
  const ct = headers.find((h) => h.key.toLowerCase() === "content-type");
  return { status, contentType: ct?.value ?? null, bytes };
}

function bytesToText(parts: Uint8Array[]): string {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return new TextDecoder().decode(all);
}

/** Interpret the gateway's JSON response conventions. */
function parseJsonResult(
  method: string,
  status: number,
  text: string,
): unknown {
  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  const ok = status >= 200 && status < 300;
  if (ok && json?.ok === true) return "result" in json ? json.result : json;
  if (ok && json && json.ok === undefined && !("error" in json)) return json;
  if (!json) {
    if (ok) return text || undefined;
    throw new GatewayRequestError(
      `HTTP ${status} for ${method}`,
      undefined,
      status,
    );
  }
  const err = json.error;
  let code: string | undefined;
  let message = `HTTP ${status} for ${method}`;
  if (typeof err === "string") message = err;
  else if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === "string") code = e.code;
    if (typeof e.message === "string") message = e.message;
  }
  if (typeof json.code === "string") code ??= json.code;
  if (typeof json.message === "string") message = json.message;
  throw new GatewayRequestError(message, code, status);
}

function openSocket(
  url: string,
  factory?: (u: string) => WebSocket,
): WebSocket {
  const ws = factory ? factory(url) : new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return ws;
}

export class MuseGateway {
  readonly #ws: WebSocket;
  readonly #transport: NoiseTransport;
  readonly #pending = new Map<bigint, Pending>();
  readonly #acceptLanguage: string;
  readonly #appId: string;
  readonly #listeners = new Set<(event: GatewayEvent) => void>();
  readonly #duplex = new Map<
    bigint,
    { onFrame: (frame: DecodedFrame) => void }
  >();
  #closed = false;
  readonly vmType: "standard" | "confidential";

  private constructor(
    ws: WebSocket,
    transport: NoiseTransport,
    opts: {
      appId: string;
      acceptLanguage: string;
      vmType: "standard" | "confidential";
    },
  ) {
    this.#ws = ws;
    this.#transport = transport;
    this.#appId = opts.appId;
    this.#acceptLanguage = opts.acceptLanguage;
    this.vmType = opts.vmType;
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onclose = () =>
      this.#failAll(new MuseError("transport", "gateway WebSocket closed"));
    ws.onerror = () =>
      this.#failAll(new MuseError("transport", "gateway WebSocket error"));
  }

  /** Dial the VM, complete the Noise XX handshake, and return a ready client. */
  static async connect(opts: ConnectOptions): Promise<MuseGateway> {
    const url = buildNoiseWsUrl(opts.gatewayUrl, {
      token: opts.credentials.token,
      notaryToken: opts.credentials.notaryToken,
      requestId: randomUUID(),
      vmName: opts.vmName ?? null,
      appId: opts.appId ?? DEFAULT_APP_ID,
    });
    let ws: WebSocket;
    try {
      ws = openSocket(url, opts.wsFactory);
    } catch {
      // Never echo the URL: it carries the auth token.
      throw new MuseError("transport", "could not construct gateway WebSocket");
    }

    const inbox: Uint8Array[] = [];
    let waiter: ((m: Uint8Array) => void) | null = null;
    let failer: ((e: unknown) => void) | null = null;
    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(data);
      } else inbox.push(data);
    };
    const next = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const queued = inbox.shift();
        if (queued) return resolve(queued);
        waiter = resolve;
        failer = reject;
      });

    const deadline = AbortSignal.any([
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      ...(opts.signal ? [opts.signal] : []),
    ]);
    const abort = () => {
      failer?.(new MuseError("timeout", "Noise handshake timed out"));
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    deadline.addEventListener("abort", abort, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () =>
          reject(
            new MuseError(
              "auth",
              "Gateway rejected the WebSocket upgrade (expired/invalid VM token, or VM asleep).",
            ),
          );
        ws.onclose = () =>
          reject(new MuseError("transport", "gateway closed before open"));
        failer = reject;
      });
      ws.onclose = () =>
        failer?.(new MuseError("handshake", "gateway closed during handshake"));

      const init = new NoiseXXInitiator();
      ws.send(init.writeMessage1(encodeMessage1Payload(createClientNonce())));
      const msg2 = await next();
      if (msg2.length > MAX_HANDSHAKE_MESSAGE) {
        throw new MuseError("handshake", "handshake message 2 too large");
      }
      const payload2 = init.readMessage2(msg2);
      const kind = classifyMessage2(payload2);
      if (kind.kind === "confidential") {
        throw new MuseError(
          "unsupported",
          `Connected VM is confidential (RV state: ${kind.state}). Confidential-VM attestation and PIN unlock are not supported; use a standard VM.`,
          { code: "cvm_unsupported" },
        );
      }
      // Standard VM: Message 3 carries an empty payload.
      ws.send(init.writeMessage3(new Uint8Array(0)));
      const [send, recv] = init.split();
      deadline.removeEventListener("abort", abort);
      return new MuseGateway(ws, new NoiseTransport(send, recv), {
        appId: opts.appId ?? DEFAULT_APP_ID,
        acceptLanguage: opts.acceptLanguage ?? "en-US",
        vmType: "standard",
      });
    } catch (err) {
      deadline.removeEventListener("abort", abort);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err instanceof MuseError) throw err;
      throw new MuseError(
        "handshake",
        `Noise handshake failed: ${(err as Error).message}`,
      );
    }
  }

  #headers(withJson: boolean): Header[] {
    return [
      ...(withJson ? [{ key: "Content-Type", value: "application/json" }] : []),
      { key: "x-request-id", value: randomUUID() },
      { key: "x-app-id", value: this.#appId },
      { key: "Accept-Language", value: this.#acceptLanguage },
      { key: "Accept-Encoding", value: "identity" },
    ];
  }

  #send(messages: Uint8Array[]): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) {
      throw new MuseError("transport", "gateway is not connected");
    }
    for (const m of messages) this.#ws.send(m);
  }

  #build(method: string, params: Record<string, unknown>) {
    const route = findRoute(method);
    if (!route)
      throw new MuseError("config", `Unknown gateway method: ${method}`);
    const { path, params: rest } = resolveRoutePath(route, params);
    const isGet = route.httpMethod === "GET";
    const sendsBody = !isGet && route.requestBody !== "empty";
    return {
      route,
      req: {
        verb: route.httpMethod,
        path: isGet ? appendQuery(path, rest) : path,
        headers: this.#headers(sendsBody),
        body: sendsBody
          ? new TextEncoder().encode(JSON.stringify(rest))
          : new Uint8Array(0),
        endBody: true,
      },
    };
  }

  /** Send a one-shot request and resolve with the parsed JSON result. */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal; binary?: boolean } = {},
  ): Promise<T> {
    const { route, req } = this.#build(method, params);
    const binary = opts.binary ?? route.responseType === "binary";
    if (route.streamMode) {
      return Promise.reject(
        new MuseError(
          "config",
          `${method} is a stream; use subscribe() instead`,
        ),
      );
    }
    const service = route.service;
    const { streamId, messages } = this.#transport.request(service, req);
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        method,
        service,
        route,
        binary,
        status: 0,
        headers: [],
        body: [],
        timer: undefined,
        resolve: (v) => resolve(v as T),
        reject,
      };
      const timeout =
        opts.timeoutMs ?? route.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      p.timer = setTimeout(
        () =>
          this.#cancel(
            streamId,
            new MuseError("timeout", `${method} timed out`),
          ),
        timeout,
      );
      opts.signal?.addEventListener(
        "abort",
        () =>
          this.#cancel(streamId, new MuseError("timeout", `${method} aborted`)),
        { once: true },
      );
      this.#pending.set(streamId, p);
      try {
        this.#send(messages);
      } catch (err) {
        this.#pending.delete(streamId);
        clearTimeout(p.timer);
        reject(err);
      }
    });
  }

  /**
   * Open a subscription stream (e.g. `chat.stream`, `chat.subscribe`).
   * Resolves with the ack; events are delivered to `onEvent` until the stream
   * ends or `close()` is called on the returned handle.
   */
  subscribe(
    method: string,
    params: Record<string, unknown>,
    onEvent: (event: GatewayEvent) => void,
  ): { ack: Promise<unknown>; done: Promise<void>; close(): void } {
    const { route, req } = this.#build(method, params);
    if (route.streamMode !== "subscription" && route.streamMode !== "records") {
      throw new MuseError("config", `${method} is not a stream`);
    }
    const service = route.service;
    const { streamId, messages } = this.#transport.request(service, req);
    let ackResolve!: (v: unknown) => void;
    let ackReject!: (e: unknown) => void;
    const ack = new Promise<unknown>((res, rej) => {
      ackResolve = res;
      ackReject = rej;
    });
    let doneResolve!: () => void;
    let doneReject!: (e: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      doneResolve = res;
      doneReject = rej;
    });
    // Avoid unhandled rejections when callers only await one of them.
    ack.catch(() => {});
    done.catch(() => {});

    const p: Pending = {
      method,
      service,
      route,
      status: 0,
      headers: [],
      body: [],
      timer: undefined,
      resolve: ackResolve,
      reject: (e) => {
        ackReject(e);
        doneReject(e);
      },
      stream: {
        acked: route.streamMode === "records",
        pendingText: "",
        decoder: new TextDecoder(),
        onEvent,
        onEnd: (err) => (err ? doneReject(err) : doneResolve()),
      },
    };
    if (route.streamMode === "records") ackResolve(undefined);
    this.#pending.set(streamId, p);
    this.#send(messages);
    return {
      ack,
      done,
      close: () => this.#cancel(streamId),
    };
  }

  /**
   * Open a raw bidirectional byte stream (request body left open). Used for
   * `browser_stream.attach`, whose body carries RFB/VNC bytes both ways.
   */
  openDuplex(
    method: string,
    params: Record<string, unknown>,
    handlers: {
      onOpen: (status: number) => void;
      onData: (bytes: Uint8Array) => void;
      onClose: (reason: string) => void;
    },
  ): DuplexStream {
    const route = findRoute(method);
    if (!route)
      throw new MuseError("config", `Unknown gateway method: ${method}`);
    const { path } = resolveRoutePath(route, params);
    const service = route.service;
    const { streamId, messages } = this.#transport.request(service, {
      verb: route.httpMethod,
      path,
      headers: this.#headers(false),
      body: new Uint8Array(0),
      endBody: false,
    });
    let opened = false;
    let closed = false;
    const finish = (reason: string) => {
      if (closed) return;
      closed = true;
      this.#duplex.delete(streamId);
      handlers.onClose(reason);
    };
    this.#duplex.set(streamId, {
      onFrame: (frame) => {
        if (frame.kind === "reset")
          return finish(`reset: ${frame.reason || frame.code}`);
        if (frame.kind === "response") {
          opened = true;
          handlers.onOpen(frame.response.status);
          if (frame.response.status < 200 || frame.response.status >= 300) {
            return finish(`HTTP ${frame.response.status}`);
          }
          if (frame.response.body.length > 0)
            handlers.onData(frame.response.body);
          if (frame.response.endBody) finish("server ended stream");
          return;
        }
        if (frame.kind === "bodyChunk") {
          if (frame.data.length > 0) handlers.onData(frame.data);
          if (frame.endBody) finish("server ended stream");
        }
      },
    });
    this.#send(messages);
    return {
      get opened() {
        return opened;
      },
      send: (bytes: Uint8Array) => {
        if (closed) return;
        this.#send(this.#transport.bodyChunk(service, streamId, bytes, false));
      },
      close: () => {
        if (closed) return;
        try {
          this.#send(
            this.#transport.bodyChunk(
              service,
              streamId,
              new Uint8Array(0),
              true,
            ),
          );
        } catch {
          // socket already gone
        }
        finish("client closed");
      },
    };
  }

  #cancel(streamId: bigint, err?: unknown): void {
    const p = this.#pending.get(streamId);
    if (!p) return;
    this.#pending.delete(streamId);
    clearTimeout(p.timer);
    try {
      this.#send(
        this.#transport.reset(p.service, streamId, "client cancelled"),
      );
    } catch {
      // socket gone
    }
    if (err) p.reject(err);
    else if (p.stream) p.stream.onEnd();
  }

  #onMessage(data: unknown): void {
    let frame: DecodedFrame | null;
    try {
      frame = this.#transport.decrypt(new Uint8Array(data as ArrayBuffer));
    } catch (err) {
      this.#failAll(
        new MuseError("transport", `decrypt failed: ${(err as Error).message}`),
      );
      this.close();
      return;
    }
    if (!frame || frame.kind === "empty" || frame.kind === "request") return;
    const duplex = this.#duplex.get(frame.streamId);
    if (duplex) {
      duplex.onFrame(frame);
      return;
    }
    const p = this.#pending.get(frame.streamId);
    if (!p) return;

    if (frame.kind === "reset") {
      this.#pending.delete(frame.streamId);
      clearTimeout(p.timer);
      const err = new MuseError(
        "gateway",
        `${p.method} reset by server: ${frame.reason || frame.code}`,
      );
      p.reject(err);
      p.stream?.onEnd(err);
      return;
    }

    let chunk: Uint8Array;
    let endBody: boolean;
    if (frame.kind === "response") {
      p.status = frame.response.status;
      p.headers = frame.response.headers;
      chunk = frame.response.body;
      endBody = frame.response.endBody;
      if (p.stream && (p.status < 200 || p.status >= 300)) {
        // Error before the stream began: collect the body as JSON error.
        p.body.push(chunk);
        if (endBody) this.#finishError(frame.streamId, p);
        return;
      }
    } else {
      chunk = frame.data;
      endBody = frame.endBody;
    }

    if (p.stream) {
      if (p.status < 200 || p.status >= 300) {
        p.body.push(chunk);
        if (endBody) this.#finishError(frame.streamId, p);
        return;
      }
      this.#feedStream(p, chunk);
      if (endBody) {
        this.#flushStreamTail(p);
        this.#pending.delete(frame.streamId);
        p.stream.onEnd();
      }
      return;
    }

    p.body.push(chunk);
    if (endBody) {
      this.#pending.delete(frame.streamId);
      clearTimeout(p.timer);
      const ok = p.status >= 200 && p.status < 300;
      if (p.binary && ok) {
        p.resolve(binaryResult(p.status, p.headers, p.body));
        return;
      }
      try {
        p.resolve(parseJsonResult(p.method, p.status, bytesToText(p.body)));
      } catch (err) {
        p.reject(err);
      }
    }
  }

  #finishError(streamId: bigint, p: Pending): void {
    this.#pending.delete(streamId);
    clearTimeout(p.timer);
    try {
      parseJsonResult(p.method, p.status, bytesToText(p.body));
      p.reject(
        new GatewayRequestError(
          `HTTP ${p.status} for ${p.method}`,
          undefined,
          p.status,
        ),
      );
    } catch (err) {
      p.reject(err);
    }
  }

  #feedStream(p: Pending, chunk: Uint8Array): void {
    const s = p.stream;
    if (!s) return;
    s.pendingText += s.decoder.decode(chunk, { stream: true });
    const lines = s.pendingText.split("\n");
    s.pendingText = lines.pop() ?? "";
    for (const line of lines) this.#handleLine(p, line);
  }

  #flushStreamTail(p: Pending): void {
    const s = p.stream;
    if (!s) return;
    s.pendingText += s.decoder.decode();
    const tail = s.pendingText.trim();
    s.pendingText = "";
    if (tail) this.#handleLine(p, tail);
  }

  #handleLine(p: Pending, rawLine: string): void {
    const s = p.stream;
    const line = rawLine.trim();
    if (!s || !line) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!s.acked) {
      s.acked = true;
      if (msg.type === "event") {
        p.resolve(undefined);
      } else {
        try {
          if (msg.ok === true && "result" in msg) p.resolve(msg.result);
          else if (msg.type === "res" && msg.status === "ok")
            p.resolve(msg.payload);
          else if (msg.ok === false || msg.status === "err" || "error" in msg) {
            parseJsonResult(p.method, 400, line);
            p.resolve(msg);
          } else p.resolve(msg);
        } catch (err) {
          p.reject(err);
          return;
        }
        return;
      }
    }
    if (msg.type === "event" && typeof msg.event === "string") {
      const event = msg as unknown as GatewayEvent;
      s.onEvent(event);
      for (const listener of this.#listeners) listener(event);
    }
  }

  /**
   * Observe every event from every open stream. The gateway fans events out
   * by name, so a turn's deltas may arrive on a different stream (typically
   * the persistent `chat.subscribe`) than the one that started it.
   */
  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #failAll(err: unknown): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
      p.stream?.onEnd(err);
      this.#pending.delete(id);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new MuseError("transport", "gateway closed"));
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
  }
}
