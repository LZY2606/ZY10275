/** MPEG-2 transport stream (ISO/IEC 13818-1) 常量与位级读取工具。 */

export const TS_PACKET_SIZE = 188;
export const SYNC_BYTE = 0x47;
export const PID_PAT = 0x0000;

export const AFC_RESERVED = 0;
export const AFC_PAYLOAD_ONLY = 1;
export const AFC_ADAPTATION_ONLY = 2;
export const AFC_ADAPTATION_AND_PAYLOAD = 3;

export const TABLE_ID_PAT = 0x00;
export const TABLE_ID_PMT = 0x02;

/**
 * 已知 stream_type（13818-1 Table 2-34 常见项）。
 * 未列入的取值一律视为 unknown，但原值与 descriptor 全部保留。
 */
export const KNOWN_STREAM_TYPES: ReadonlySet<number> = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0f, 0x10, 0x11, 0x1b, 0x24, 0x80, 0x81,
  0x82, 0x86, 0x87, 0x0d, 0x8a,
]);

export const STREAM_TYPE_LABELS: Record<number, string> = {
  0x00: 'ITU-T | ISO/IEC Reserved',
  0x01: 'ISO/IEC 11172-2 Video',
  0x02: 'ITU-T H.262 | ISO/IEC 13818-2 Video',
  0x03: 'ISO/IEC 11172-3 Audio',
  0x04: 'ISO/IEC 13818-3 Audio',
  0x05: 'ITU-T H.222.0 private sections',
  0x06: 'ITU-T H.222.0 PES private data',
  0x0d: 'ISO/IEC 13818-7 ADTS AAC',
  0x0f: 'ISO/IEC 13818-7 ADTS AAC',
  0x10: 'ISO/IEC 14496-2 Video',
  0x11: 'ISO/IEC 14496-3 LATM AAC',
  0x1b: 'ITU-T H.264 | ISO/IEC 14496-10 Video',
  0x24: 'ITU-T H.265 | ISO/IEC 23008-2 Video',
  0x80: 'ATSC A/53 AC-3 audio',
  0x81: 'ATSC DTS audio',
  0x82: 'ATSC E-AC-3 audio',
  0x86: 'ATSC DTS-HD audio',
  0x87: 'ATSC E-AC-3 (A/52b) audio',
  0x8a: 'DTS HD-Master Audio',
};

export function streamTypeLabel(t: number): string {
  return STREAM_TYPE_LABELS[t] ?? `Unknown stream type 0x${t.toString(16).padStart(2, '0')}`;
}

/** 读 MSB 起始、bitOffset 起 width 位的无符号整数（width <= 32）。 */
export function readBits(data: Uint8Array, byteOffset: number, bitOffset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    const absBit = byteOffset * 8 + bitOffset + i;
    const bit = (data[absBit >> 3]! >> (7 - (absBit & 7))) & 1;
    value = (value << 1) | bit;
  }
  return value >>> 0;
}

export function readU16(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 8) | data[offset + 1]!) >>> 0;
}

export function readU32(data: Uint8Array, offset: number): number {
  return (((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0);
}

export interface ParsedPcr {
  base: bigint;
  extension: number;
  /** base*300 + extension 的 42 位原值。 */
  raw: bigint;
}

/** 从 adaptation field 中 6 字节 PCR 字段解析。 */
export function parsePcr(data: Uint8Array, offset: number): ParsedPcr {
  const b0 = BigInt(data[offset]!);
  const b1 = BigInt(data[offset + 1]!);
  const b2 = BigInt(data[offset + 2]!);
  const b3 = BigInt(data[offset + 3]!);
  const b4 = BigInt(data[offset + 4]!);
  const b5 = BigInt(data[offset + 5]!);
  const base = (b0 << 25n) | (b1 << 17n) | (b2 << 9n) | (b3 << 1n) | (b4 >> 7n);
  const ext = Number(((b4 & 0x01n) << 8n) | b5);
  return { base, extension: ext, raw: base * 300n + BigInt(ext) };
}

/** 以 90kHz base 为锚展开 PCR（回绕 2^33 base），输出 27MHz tick 的单调序列。 */
export function unwrapPcr(
  rawValues: ReadonlyArray<bigint>,
  baseValues: ReadonlyArray<bigint>,
): bigint[] {
  const BASE_WRAP = 1n << 33n;
  const HALF = (BASE_WRAP / 2n) * 300n;
  const out: bigint[] = [];
  let wraps = 0n;
  let prev: bigint | null = null;
  for (let i = 0; i < rawValues.length; i++) {
    const raw = rawValues[i]!;
    const candidate = raw + wraps * BASE_WRAP * 300n;
    if (prev !== null) {
      const delta = candidate - prev;
      if (delta < -HALF) {
        wraps += 1n;
      } else if (delta > HALF) {
        wraps -= 1n;
      }
    }
    const value = raw + wraps * BASE_WRAP * 300n;
    out.push(value);
    prev = value;
  }
  return out;
}

/** version_number 的 mod-32 前向距离：v1 -> v2（0..31）。 */
export function versionForwardDistance(from: number, to: number): number {
  return (to - from + 32) % 32;
}
