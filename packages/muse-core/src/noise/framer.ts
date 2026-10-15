/**
 * Splits an application message into `NoiseTransportFrame` chunks so each fits
 * one Noise transport message (65535 bytes incl. the 16-byte AEAD tag), and
 * reassembles chunks received from the peer.
 */
import { randomBytes } from "node:crypto";
import {
  fieldBytes,
  fieldVarint,
  ProtoWriter,
  readProtoFields,
} from "./protobuf.js";

/** 65535 - 16 (AEAD tag) - ~30 bytes of frame overhead. */
export const MAX_CHUNK_PAYLOAD = 65_489;
const MAX_TOTAL_CHUNKS = 256;
const MAX_PENDING = 16;
const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const ASSEMBLY_TTL_MS = 60_000;

function encodeFrame(
  chunkId: bigint,
  index: number,
  total: number,
  payload: Uint8Array,
): Uint8Array {
  // All four fields are proto3 `optional`, so we always emit them.
  return new ProtoWriter()
    .varintAlways(1, chunkId)
    .varintAlways(2, index)
    .varintAlways(3, total)
    .bytesAlways(4, payload)
    .finish();
}

export function encodeNoiseFrames(data: Uint8Array): Uint8Array[] {
  const chunkId = randomBytes(8).readBigInt64LE(0);
  const total = Math.max(1, Math.ceil(data.length / MAX_CHUNK_PAYLOAD));
  if (total > MAX_TOTAL_CHUNKS) {
    throw new Error(`framer: payload too large (${data.length} bytes)`);
  }
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const start = i * MAX_CHUNK_PAYLOAD;
    frames.push(
      encodeFrame(
        chunkId,
        i,
        total,
        data.subarray(start, start + MAX_CHUNK_PAYLOAD),
      ),
    );
  }
  return frames;
}

interface Assembly {
  readonly total: number;
  readonly chunks: Map<number, Uint8Array>;
  bytes: number;
  readonly createdAt: number;
}

export class NoiseFrameDecoder {
  readonly #pending = new Map<bigint, Assembly>();

  /** Returns the reassembled message once complete, else null. */
  decode(frameBytes: Uint8Array): Uint8Array | null {
    const f = readProtoFields(frameBytes);
    // Peers may omit default-valued fields; apply proto3 defaults.
    const chunkId = BigInt.asIntN(64, fieldVarint(f, 1) ?? 0n);
    const index = Number(fieldVarint(f, 2) ?? 0n);
    const total = Number(fieldVarint(f, 3) ?? 1n);
    const payload = fieldBytes(f, 4) ?? new Uint8Array(0);

    if (total < 1 || total > MAX_TOTAL_CHUNKS) {
      throw new Error(`framer: invalid total_chunks ${total}`);
    }
    if (index < 0 || index >= total) {
      throw new Error(`framer: chunk_index ${index} out of range`);
    }
    if (total === 1) return new Uint8Array(payload);

    this.#evictExpired();
    let asm = this.#pending.get(chunkId);
    if (!asm) {
      if (this.#pending.size >= MAX_PENDING) {
        throw new Error("framer: too many pending assemblies");
      }
      asm = { total, chunks: new Map(), bytes: 0, createdAt: Date.now() };
      this.#pending.set(chunkId, asm);
    }
    if (asm.total !== total)
      throw new Error("framer: inconsistent total_chunks");
    if (asm.chunks.has(index))
      throw new Error(`framer: duplicate chunk ${index}`);
    asm.bytes += payload.length;
    if (asm.bytes > MAX_ASSEMBLY_BYTES) {
      this.#pending.delete(chunkId);
      throw new Error("framer: assembly exceeded byte budget");
    }
    asm.chunks.set(index, new Uint8Array(payload));
    if (asm.chunks.size < asm.total) return null;

    this.#pending.delete(chunkId);
    const out = new Uint8Array(asm.bytes);
    let off = 0;
    for (let i = 0; i < asm.total; i++) {
      const part = asm.chunks.get(i) as Uint8Array;
      out.set(part, off);
      off += part.length;
    }
    return out;
  }

  #evictExpired(): void {
    const now = Date.now();
    for (const [id, asm] of this.#pending) {
      if (now - asm.createdAt > ASSEMBLY_TTL_MS) this.#pending.delete(id);
    }
  }
}
