import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/** DER SPKI prefix for a raw 32-byte X25519 public key (RFC 8410). */
const X25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

export const DH_LEN = 32;

export interface X25519KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: Uint8Array;
}

export function generateKeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKey: new Uint8Array(der.subarray(-DH_LEN)) };
}

function importPublic(raw: Uint8Array): KeyObject {
  if (raw.length !== DH_LEN) {
    throw new Error(`x25519: public key must be ${DH_LEN} bytes`);
  }
  const der = new Uint8Array(X25519_SPKI_PREFIX.length + DH_LEN);
  der.set(X25519_SPKI_PREFIX, 0);
  der.set(raw, X25519_SPKI_PREFIX.length);
  return createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  });
}

export function dh(
  privateKey: KeyObject,
  remotePublic: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    diffieHellman({ privateKey, publicKey: importPublic(remotePublic) }),
  );
}
