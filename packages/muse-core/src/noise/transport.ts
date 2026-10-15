import type { NoiseService } from "../rpc-catalog.js";
import {
  type ApplicationRequest,
  type DecodedFrame,
  decodeServiceResponse,
  encodeBodyChunkFrame,
  encodeRequestFrame,
  encodeResetFrame,
  RESET_CODE,
} from "./envelope.js";
import { encodeNoiseFrames, NoiseFrameDecoder } from "./framer.js";
import type { CipherState } from "./noise-xx.js";

const EMPTY_AD = new Uint8Array(0);

/**
 * Post-handshake transport. Turns logical HTTP requests into encrypted
 * WebSocket messages and decrypts inbound messages back into frames.
 *
 * Cipher nonces advance on every message, so every encrypted message MUST be
 * sent in order, and every inbound message MUST be passed to `decrypt`.
 */
export class NoiseTransport {
  readonly #send: CipherState;
  readonly #recv: CipherState;
  readonly #decoder = new NoiseFrameDecoder();
  #nextStreamId = 1n;
  #dead = false;

  constructor(send: CipherState, recv: CipherState) {
    this.#send = send;
    this.#recv = recv;
  }

  #guard<T>(fn: () => T): T {
    if (this.#dead) throw new Error("noise transport is dead after a failure");
    try {
      return fn();
    } catch (err) {
      this.#dead = true;
      throw err;
    }
  }

  #seal(serviceRequest: Uint8Array): Uint8Array[] {
    return encodeNoiseFrames(serviceRequest).map((frame) =>
      this.#send.encryptWithAd(EMPTY_AD, frame),
    );
  }

  request(
    service: NoiseService,
    req: ApplicationRequest,
  ): { streamId: bigint; messages: Uint8Array[] } {
    return this.#guard(() => {
      const streamId = this.#nextStreamId++;
      return {
        streamId,
        messages: this.#seal(encodeRequestFrame(service, streamId, req)),
      };
    });
  }

  bodyChunk(
    service: NoiseService,
    streamId: bigint,
    data: Uint8Array,
    endBody: boolean,
  ): Uint8Array[] {
    return this.#guard(() =>
      this.#seal(encodeBodyChunkFrame(service, streamId, data, endBody)),
    );
  }

  reset(service: NoiseService, streamId: bigint, reason: string): Uint8Array[] {
    return this.#guard(() =>
      this.#seal(
        encodeResetFrame(service, streamId, RESET_CODE.CANCELLED, reason),
      ),
    );
  }

  /** Returns a frame once a full message is reassembled, else null. */
  decrypt(ciphertext: Uint8Array): DecodedFrame | null {
    return this.#guard(() => {
      const plain = this.#recv.decryptWithAd(EMPTY_AD, ciphertext);
      const whole = this.#decoder.decode(plain);
      return whole === null ? null : decodeServiceResponse(whole);
    });
  }

  get isDead(): boolean {
    return this.#dead;
  }
}
