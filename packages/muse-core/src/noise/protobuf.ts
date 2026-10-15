/**
 * Minimal proto3 wire codec — just enough for the handful of small, fixed
 * messages the Muse gateway uses. Avoids a protobuf runtime dependency.
 *
 * Wire types: 0 = varint, 2 = length-delimited. That is all we need.
 */

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export class ProtoWriter {
  readonly #chunks: number[] = [];

  #varint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    while (v >= 0x80n) {
      this.#chunks.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.#chunks.push(Number(v));
  }

  #tag(field: number, wire: number): void {
    this.#varint(BigInt((field << 3) | wire));
  }

  /** int32/int64/uint32/enum/bool. Skips proto3 default (0) values. */
  varint(field: number, value: number | bigint | boolean): this {
    const big = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
    if (big === 0n) return this;
    this.#tag(field, WIRE_VARINT);
    this.#varint(big);
    return this;
  }

  /** Always-emit varint (for `optional` fields where 0 must be present). */
  varintAlways(field: number, value: number | bigint): this {
    this.#tag(field, WIRE_VARINT);
    this.#varint(BigInt(value));
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    if (value.length === 0) return this;
    return this.bytesAlways(field, value);
  }

  bytesAlways(field: number, value: Uint8Array): this {
    this.#tag(field, WIRE_LEN);
    this.#varint(BigInt(value.length));
    for (const b of value) this.#chunks.push(b);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  message(field: number, value: Uint8Array): this {
    return this.bytesAlways(field, value);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#chunks);
  }
}

export type ProtoField =
  | { field: number; wire: 0; value: bigint }
  | { field: number; wire: 2; value: Uint8Array };

/** Decode a message into its raw fields, in wire order. */
export function readProtoFields(data: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= data.length) throw new Error("protobuf: truncated varint");
      const byte = data[pos++] as number;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("protobuf: varint too long");
    }
  };
  while (pos < data.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new Error("protobuf: invalid field 0");
    if (wire === WIRE_VARINT) {
      out.push({ field, wire: 0, value: readVarint() });
    } else if (wire === WIRE_LEN) {
      const len = Number(readVarint());
      if (pos + len > data.length) throw new Error("protobuf: truncated bytes");
      out.push({ field, wire: 2, value: data.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
  return out;
}

export function fieldBytes(
  fields: ProtoField[],
  field: number,
): Uint8Array | undefined {
  const f = fields.find((x) => x.field === field && x.wire === 2);
  return f?.wire === 2 ? f.value : undefined;
}

export function fieldVarint(
  fields: ProtoField[],
  field: number,
): bigint | undefined {
  const f = fields.find((x) => x.field === field && x.wire === 0);
  return f?.wire === 0 ? f.value : undefined;
}

export function fieldString(
  fields: ProtoField[],
  field: number,
): string | undefined {
  const b = fieldBytes(fields, field);
  return b === undefined ? undefined : new TextDecoder().decode(b);
}
