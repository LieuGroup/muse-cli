import { describe, expect, it } from "vitest";
import { decodeServiceResponse } from "./envelope.js";
import {
  encodeNoiseFrames,
  MAX_CHUNK_PAYLOAD,
  NoiseFrameDecoder,
} from "./framer.js";
import {
  classifyMessage2,
  createClientNonce,
  encodeMessage1Payload,
} from "./handshake-payloads.js";
import { NoiseXXInitiator, NoiseXXResponder } from "./noise-xx.js";
import { fieldBytes, ProtoWriter, readProtoFields } from "./protobuf.js";
import { NoiseTransport } from "./transport.js";

function handshake(message2Payload = new Uint8Array(0)) {
  const init = new NoiseXXInitiator();
  const resp = new NoiseXXResponder(message2Payload);
  const msg1 = init.writeMessage1(encodeMessage1Payload(createClientNonce()));
  const msg2 = resp.readMessage1WriteMessage2(msg1);
  const payload2 = init.readMessage2(msg2);
  const msg3 = init.writeMessage3(new Uint8Array(0));
  resp.readMessage3(msg3);
  return { init, resp, payload2 };
}

describe("Noise XX", () => {
  it("completes a handshake and agrees on transport keys", () => {
    const { init, resp, payload2 } = handshake(
      new TextEncoder().encode("attest"),
    );
    expect(new TextDecoder().decode(payload2)).toBe("attest");
    expect(init.remoteStaticPublicKey()).toEqual(resp.staticPublicKey);

    const [iSend, iRecv] = init.split();
    const [rSend, rRecv] = resp.split();
    const ad = new Uint8Array(0);
    const ct = iSend.encryptWithAd(ad, new TextEncoder().encode("ping"));
    expect(new TextDecoder().decode(rRecv.decryptWithAd(ad, ct))).toBe("ping");
    const back = rSend.encryptWithAd(ad, new TextEncoder().encode("pong"));
    expect(new TextDecoder().decode(iRecv.decryptWithAd(ad, back))).toBe(
      "pong",
    );
  });

  it("rejects a tampered message 2", () => {
    const init = new NoiseXXInitiator();
    const resp = new NoiseXXResponder();
    const msg2 = resp.readMessage1WriteMessage2(init.writeMessage1());
    msg2[msg2.length - 1] ^= 0xff;
    expect(() => init.readMessage2(msg2)).toThrow();
  });
});

describe("framer", () => {
  it("round-trips a multi-chunk message", () => {
    const data = new Uint8Array(MAX_CHUNK_PAYLOAD * 2 + 17).map(
      (_, i) => i & 0xff,
    );
    const frames = encodeNoiseFrames(data);
    expect(frames).toHaveLength(3);
    const dec = new NoiseFrameDecoder();
    let out: Uint8Array | null = null;
    for (const f of frames) out = dec.decode(f);
    expect(out).toEqual(data);
  });

  it("treats omitted default fields as a single chunk", () => {
    const payload = new TextEncoder().encode("x");
    const frame = new ProtoWriter().bytes(4, payload).finish();
    expect(new NoiseFrameDecoder().decode(frame)).toEqual(payload);
  });
});

describe("transport + envelope", () => {
  it("encrypts a request the responder can decode", () => {
    const { init, resp } = handshake();
    const [iSend, iRecv] = init.split();
    const [, rRecv] = resp.split();
    const transport = new NoiseTransport(iSend, iRecv);
    const { streamId, messages } = transport.request("daemon", {
      verb: "POST",
      path: "/chat/stream",
      headers: [{ key: "x-app-id", value: "hatch-web" }],
      body: new TextEncoder().encode('{"message":"hi"}'),
      endBody: true,
    });
    expect(streamId).toBe(1n);
    const dec = new NoiseFrameDecoder();
    const plain = dec.decode(
      rRecv.decryptWithAd(new Uint8Array(0), messages[0] as Uint8Array),
    );
    const outer = readProtoFields(plain as Uint8Array);
    const frame = readProtoFields(fieldBytes(outer, 2) as Uint8Array);
    const appReq = readProtoFields(fieldBytes(frame, 2) as Uint8Array);
    expect(new TextDecoder().decode(fieldBytes(appReq, 2))).toBe(
      "/chat/stream",
    );
  });

  it("decodes a server ApplicationResponse", () => {
    const header = new ProtoWriter()
      .string(1, "content-type")
      .string(2, "application/json")
      .finish();
    const appResp = new ProtoWriter()
      .varint(1, 200)
      .message(2, header)
      .bytes(3, new TextEncoder().encode('{"ok":true}'))
      .varint(4, true)
      .finish();
    const frame = new ProtoWriter().varint(1, 7n).message(3, appResp).finish();
    const svc = new ProtoWriter().bytes(1, frame).finish();
    const decoded = decodeServiceResponse(svc);
    expect(decoded.kind).toBe("response");
    if (decoded.kind !== "response") return;
    expect(decoded.streamId).toBe(7n);
    expect(decoded.response.status).toBe(200);
    expect(decoded.response.headers[0]?.key).toBe("content-type");
    expect(decoded.response.endBody).toBe(true);
  });
});

describe("message 2 classification", () => {
  it("detects a confidential RV challenge", () => {
    const payload = new ProtoWriter()
      .bytes(1, new Uint8Array([1, 2, 3]))
      .varint(2, 1)
      .bytes(3, new Uint8Array(32).fill(9))
      .finish();
    expect(classifyMessage2(payload)).toEqual({
      kind: "confidential",
      state: "unprovisioned",
      hasChipBinding: false,
    });
  });

  it("treats an opaque attestation blob as standard", () => {
    expect(classifyMessage2(new Uint8Array([0xff, 0x00, 0x12]))).toEqual({
      kind: "standard",
    });
  });
});
