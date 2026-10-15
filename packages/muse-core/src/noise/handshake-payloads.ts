/**
 * Handshake payloads carried inside Noise messages 1 and 2.
 *
 * Message 1 payload: `{ 1: client_nonce (32 bytes) }` — a freshness challenge.
 *
 * Message 2 payload is one of:
 *   - a raw attestation blob (standard VM), or
 *   - an RV challenge (confidential VM):
 *       { 1: attestation, 2: state (1=unprovisioned, 2=provisioned),
 *         3: vm_nonce (32), 4: vm_proof (32, provisioned only),
 *         5: chip_binding }
 *
 * A confidential VM additionally requires a Message 3 proof derived from a
 * per-VM recovery key that is unlocked by the user's PIN. That flow is NOT
 * implemented here; we detect it and fail with a clear error.
 */
import { randomBytes } from "node:crypto";
import {
  fieldBytes,
  fieldVarint,
  ProtoWriter,
  readProtoFields,
} from "./protobuf.js";

export const CLIENT_NONCE_LEN = 32;

export function createClientNonce(): Uint8Array {
  return new Uint8Array(randomBytes(CLIENT_NONCE_LEN));
}

export function encodeMessage1Payload(clientNonce: Uint8Array): Uint8Array {
  if (clientNonce.length !== CLIENT_NONCE_LEN) {
    throw new Error("client nonce must be 32 bytes");
  }
  return new ProtoWriter().bytesAlways(1, clientNonce).finish();
}

export type Message2Kind =
  | { kind: "standard" }
  | {
      kind: "confidential";
      state: "unprovisioned" | "provisioned";
      hasChipBinding: boolean;
    };

/**
 * Classify the Message 2 payload. A payload is treated as a confidential RV
 * challenge only when it has the full, unambiguous shape; anything else is a
 * standard VM's attestation blob.
 */
export function classifyMessage2(payload: Uint8Array): Message2Kind {
  let fields: ReturnType<typeof readProtoFields>;
  try {
    fields = readProtoFields(payload);
  } catch {
    return { kind: "standard" };
  }
  const attestation = fieldBytes(fields, 1);
  const state = fieldVarint(fields, 2);
  const vmNonce = fieldBytes(fields, 3);
  const vmProof = fieldBytes(fields, 4);
  if (attestation === undefined || vmNonce?.length !== 32) {
    return { kind: "standard" };
  }
  if (state === 1n && vmProof === undefined) {
    return {
      kind: "confidential",
      state: "unprovisioned",
      hasChipBinding: fieldBytes(fields, 5) !== undefined,
    };
  }
  if (state === 2n && vmProof?.length === 32) {
    return {
      kind: "confidential",
      state: "provisioned",
      hasChipBinding: fieldBytes(fields, 5) !== undefined,
    };
  }
  return { kind: "standard" };
}
