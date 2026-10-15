/**
 * Wire envelope for HTTP-over-Noise.
 *
 * Each logical request/response is a protobuf `ServiceFrame` wrapped in a
 * `ServiceRequest`/`ServiceResponse`, then split into `NoiseTransportFrame`
 * chunks (each chunk is one Noise transport message, <= 65535 bytes).
 *
 *   ServiceRequest      { 1: service(enum), 2: payload(bytes = ServiceFrame) }
 *   ServiceResponse     { 1: payload(bytes = ServiceFrame) }
 *   ServiceFrame        { 1: stream_id(int64), oneof kind {
 *                           2: request(ApplicationRequest)
 *                           3: response(ApplicationResponse)
 *                           4: body_chunk(BodyChunk)
 *                           5: reset(Reset) } }
 *   Header              { 1: key, 2: value }
 *   ApplicationRequest  { 1: verb, 2: path, 3: headers[], 4: body, 5: end_body }
 *   ApplicationResponse { 1: status(int32), 2: headers[], 3: body, 4: end_body }
 *   BodyChunk           { 1: data, 2: end_body }
 *   Reset               { 1: code(enum), 2: reason }
 *   NoiseTransportFrame { 1: chunk_id(int64), 2: chunk_index, 3: total_chunks,
 *                         4: payload }   (all `optional`)
 */
import type { NoiseService } from "../rpc-catalog.js";
import {
  fieldBytes,
  fieldString,
  fieldVarint,
  ProtoWriter,
  readProtoFields,
} from "./protobuf.js";

export const SERVICE_CODE: Record<NoiseService, number> = {
  daemon: 0,
  sentinel: 1,
  vault: 2,
  authd: 3,
  ssh_access: 4,
};

export const RESET_CODE = {
  UNSPECIFIED: 0,
  CANCELLED: 1,
  TIMEOUT: 2,
  PROTOCOL_ERROR: 3,
  REFUSED_STREAM: 4,
  INTERNAL_ERROR: 5,
  SERVICE_UNAVAILABLE: 6,
} as const;

export interface Header {
  readonly key: string;
  readonly value: string;
}

export interface ApplicationRequest {
  readonly verb: string;
  readonly path: string;
  readonly headers: readonly Header[];
  readonly body: Uint8Array;
  readonly endBody: boolean;
}

export interface ApplicationResponse {
  readonly status: number;
  readonly headers: Header[];
  readonly body: Uint8Array;
  readonly endBody: boolean;
}

export type DecodedFrame =
  | { kind: "response"; streamId: bigint; response: ApplicationResponse }
  | { kind: "bodyChunk"; streamId: bigint; data: Uint8Array; endBody: boolean }
  | { kind: "reset"; streamId: bigint; code: number; reason: string }
  | { kind: "request"; streamId: bigint }
  /** A frame whose oneof is unset; carries no information and is ignored. */
  | { kind: "empty"; streamId: bigint };

function encodeHeader(h: Header): Uint8Array {
  return new ProtoWriter().string(1, h.key).string(2, h.value).finish();
}

function decodeHeaders(raw: Uint8Array[]): Header[] {
  return raw.map((bytes) => {
    const f = readProtoFields(bytes);
    return { key: fieldString(f, 1) ?? "", value: fieldString(f, 2) ?? "" };
  });
}

function wrapRequest(service: NoiseService, frame: Uint8Array): Uint8Array {
  return new ProtoWriter()
    .varint(1, SERVICE_CODE[service])
    .bytes(2, frame)
    .finish();
}

export function encodeRequestFrame(
  service: NoiseService,
  streamId: bigint,
  req: ApplicationRequest,
): Uint8Array {
  const w = new ProtoWriter().string(1, req.verb).string(2, req.path);
  for (const h of req.headers) w.message(3, encodeHeader(h));
  w.bytes(4, req.body).varint(5, req.endBody);
  const frame = new ProtoWriter()
    .varint(1, streamId)
    .message(2, w.finish())
    .finish();
  return wrapRequest(service, frame);
}

export function encodeBodyChunkFrame(
  service: NoiseService,
  streamId: bigint,
  data: Uint8Array,
  endBody: boolean,
): Uint8Array {
  const chunk = new ProtoWriter().bytes(1, data).varint(2, endBody).finish();
  const frame = new ProtoWriter()
    .varint(1, streamId)
    .message(4, chunk)
    .finish();
  return wrapRequest(service, frame);
}

export function encodeResetFrame(
  service: NoiseService,
  streamId: bigint,
  code: number,
  reason: string,
): Uint8Array {
  const reset = new ProtoWriter().varint(1, code).string(2, reason).finish();
  const frame = new ProtoWriter()
    .varint(1, streamId)
    .message(5, reset)
    .finish();
  return wrapRequest(service, frame);
}

/** Decode a reassembled `ServiceResponse` into its frame. */
export function decodeServiceResponse(bytes: Uint8Array): DecodedFrame {
  const outer = readProtoFields(bytes);
  const payload = fieldBytes(outer, 1);
  if (!payload || payload.length === 0) {
    throw new Error("envelope: empty ServiceResponse payload");
  }
  const frame = readProtoFields(payload);
  const streamId = BigInt.asIntN(64, fieldVarint(frame, 1) ?? 0n);

  const response = fieldBytes(frame, 3);
  if (response) {
    const f = readProtoFields(response);
    const headerBytes = f
      .filter((x) => x.field === 2 && x.wire === 2)
      .map((x) => x.value as Uint8Array);
    return {
      kind: "response",
      streamId,
      response: {
        status: Number(BigInt.asIntN(32, fieldVarint(f, 1) ?? 0n)),
        headers: decodeHeaders(headerBytes),
        body: fieldBytes(f, 3) ?? new Uint8Array(0),
        endBody: (fieldVarint(f, 4) ?? 0n) !== 0n,
      },
    };
  }
  const chunk = fieldBytes(frame, 4);
  if (chunk) {
    const f = readProtoFields(chunk);
    return {
      kind: "bodyChunk",
      streamId,
      data: fieldBytes(f, 1) ?? new Uint8Array(0),
      endBody: (fieldVarint(f, 2) ?? 0n) !== 0n,
    };
  }
  const reset = fieldBytes(frame, 5);
  if (reset) {
    const f = readProtoFields(reset);
    return {
      kind: "reset",
      streamId,
      code: Number(fieldVarint(f, 1) ?? 0n),
      reason: fieldString(f, 2) ?? "",
    };
  }
  if (fieldBytes(frame, 2)) return { kind: "request", streamId };
  return { kind: "empty", streamId };
}
