/**
 * Noise_XX_25519_AESGCM_SHA256 initiator, written from the Noise Protocol
 * Framework specification (revision 34): https://noiseprotocol.org/noise.html
 *
 *   XX:
 *     -> e
 *     <- e, ee, s, es
 *     -> s, se
 *
 * Uses node:crypto (X25519, AES-256-GCM, SHA-256/HMAC). Prologue is empty.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { DH_LEN, dh, generateKeyPair, type X25519KeyPair } from "./x25519.js";

export const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";
const HASH_LEN = 32;
const TAG_LEN = 16;
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

/** Noise HKDF with two outputs. */
function hkdf2(
  chainingKey: Uint8Array,
  ikm: Uint8Array,
): [Uint8Array, Uint8Array] {
  const temp = hmac(chainingKey, ikm);
  const out1 = hmac(temp, Uint8Array.of(0x01));
  const out2 = hmac(temp, concat(out1, Uint8Array.of(0x02)));
  temp.fill(0);
  return [out1, out2];
}

/** AESGCM nonce: 4 zero bytes then the 64-bit counter, big-endian. */
function nonceIv(n: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(Math.floor(n / 0x1_0000_0000), 4);
  iv.writeUInt32BE(n >>> 0, 8);
  return iv;
}

export class CipherState {
  #key: Uint8Array | null = null;
  #n = 0;

  initializeKey(key: Uint8Array): void {
    this.#key = new Uint8Array(key);
    this.#n = 0;
  }

  hasKey(): boolean {
    return this.#key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#key === null) return plaintext;
    if (this.#n >= MAX_NONCE) throw new Error("noise: nonce exhausted");
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.#key,
      nonceIv(this.#n++),
      {
        authTagLength: TAG_LEN,
      },
    );
    cipher.setAAD(ad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(Buffer.concat([ct, cipher.getAuthTag()]));
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#key === null) return ciphertext;
    if (this.#n >= MAX_NONCE) throw new Error("noise: nonce exhausted");
    if (ciphertext.length < TAG_LEN)
      throw new Error("noise: ciphertext too short");
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      nonceIv(this.#n++),
      {
        authTagLength: TAG_LEN,
      },
    );
    decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    return new Uint8Array(
      Buffer.concat([decipher.update(body), decipher.final()]),
    );
  }

  destroy(): void {
    this.#key?.fill(0);
    this.#key = null;
  }
}

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  readonly cipher = new CipherState();

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL_NAME);
    const h = new Uint8Array(HASH_LEN);
    if (name.length <= HASH_LEN) h.set(name);
    this.h = name.length <= HASH_LEN ? h : sha256(name);
    this.ck = new Uint8Array(this.h);
    this.mixHash(new Uint8Array(0)); // empty prologue
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher.initializeKey(k);
    k.fill(0);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    k1.fill(0);
    k2.fill(0);
    return [c1, c2];
  }
}

type Phase = "init" | "sent1" | "read2" | "sent3" | "split" | "dead";

export class NoiseXXInitiator {
  readonly #ss = new SymmetricState();
  #e: X25519KeyPair | null = null;
  #s: X25519KeyPair | null = null;
  #re: Uint8Array | null = null;
  #rs: Uint8Array | null = null;
  #phase: Phase = "init";

  #expect(phase: Phase, op: string): void {
    if (this.#phase !== phase) {
      throw new Error(
        `noise: ${op} in phase ${this.#phase} (expected ${phase})`,
      );
    }
  }

  /** -> e, payload */
  writeMessage1(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.#expect("init", "writeMessage1");
    this.#e = generateKeyPair();
    this.#ss.mixHash(this.#e.publicKey);
    const enc = this.#ss.encryptAndHash(payload);
    this.#phase = "sent1";
    return concat(this.#e.publicKey, enc);
  }

  /** <- e, ee, s, es, payload. Returns the decrypted payload. */
  readMessage2(msg: Uint8Array): Uint8Array {
    this.#expect("sent1", "readMessage2");
    const minLen = DH_LEN + (DH_LEN + TAG_LEN) + TAG_LEN;
    if (msg.length < minLen) {
      this.#phase = "dead";
      throw new Error(`noise: message 2 too short (${msg.length} < ${minLen})`);
    }
    const e = this.#e as X25519KeyPair;
    let off = 0;
    this.#re = msg.slice(off, off + DH_LEN);
    off += DH_LEN;
    this.#ss.mixHash(this.#re);
    this.#ss.mixKey(dh(e.privateKey, this.#re));
    this.#rs = this.#ss.decryptAndHash(
      msg.subarray(off, off + DH_LEN + TAG_LEN),
    );
    off += DH_LEN + TAG_LEN;
    this.#ss.mixKey(dh(e.privateKey, this.#rs));
    const payload = this.#ss.decryptAndHash(msg.subarray(off));
    this.#phase = "read2";
    return payload;
  }

  /** -> s, se, payload */
  writeMessage3(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.#expect("read2", "writeMessage3");
    this.#s = generateKeyPair();
    const encS = this.#ss.encryptAndHash(this.#s.publicKey);
    this.#ss.mixKey(dh(this.#s.privateKey, this.#re as Uint8Array));
    const encPayload = this.#ss.encryptAndHash(payload);
    this.#phase = "sent3";
    return concat(encS, encPayload);
  }

  /** Returns [send, receive] cipher states for the initiator. */
  split(): [CipherState, CipherState] {
    this.#expect("sent3", "split");
    this.#phase = "split";
    return this.#ss.split();
  }

  handshakeHash(): Uint8Array {
    return new Uint8Array(this.#ss.h);
  }

  remoteStaticPublicKey(): Uint8Array | null {
    return this.#rs ? new Uint8Array(this.#rs) : null;
  }
}

/**
 * Responder side. Used only by tests to prove the initiator interoperates
 * with an independent implementation of the same state machine.
 */
export class NoiseXXResponder {
  readonly #ss = new SymmetricState();
  readonly #s = generateKeyPair();
  #e: X25519KeyPair | null = null;
  #re: Uint8Array | null = null;

  constructor(readonly message2Payload: Uint8Array = new Uint8Array(0)) {}

  readMessage1WriteMessage2(msg1: Uint8Array): Uint8Array {
    this.#re = msg1.slice(0, DH_LEN);
    this.#ss.mixHash(this.#re);
    this.#ss.decryptAndHash(msg1.subarray(DH_LEN));
    this.#e = generateKeyPair();
    this.#ss.mixHash(this.#e.publicKey);
    this.#ss.mixKey(dh(this.#e.privateKey, this.#re));
    const encS = this.#ss.encryptAndHash(this.#s.publicKey);
    this.#ss.mixKey(dh(this.#s.privateKey, this.#re));
    const encPayload = this.#ss.encryptAndHash(this.message2Payload);
    return concat(this.#e.publicKey, encS, encPayload);
  }

  readMessage3(msg3: Uint8Array): Uint8Array {
    const rs = this.#ss.decryptAndHash(msg3.subarray(0, DH_LEN + TAG_LEN));
    this.#ss.mixKey(dh((this.#e as X25519KeyPair).privateKey, rs));
    return this.#ss.decryptAndHash(msg3.subarray(DH_LEN + TAG_LEN));
  }

  /** Returns [send, receive] from the responder's perspective. */
  split(): [CipherState, CipherState] {
    const [c1, c2] = this.#ss.split();
    return [c2, c1];
  }

  get staticPublicKey(): Uint8Array {
    return this.#s.publicKey;
  }
}
