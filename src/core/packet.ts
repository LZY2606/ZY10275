/** 传输流物理层：188/192/204 封装判断、同步、TS 头与 adaptation field 解析。 */

import { AFC_ADAPTATION_ONLY, AFC_ADAPTATION_AND_PAYLOAD, SYNC_BYTE, TS_PACKET_SIZE } from './mpeg.js';
import { parsePcr } from './mpeg.js';
import type { AdaptationField, FrameSize, PcrValue, TsPacket } from './types.js';

export interface FrameDetectResult {
  frameSize: FrameSize;
  /** 同步前跳过的垃圾字节数（第一个帧起点之前）。 */
  skippedLeader: number;
  /** sync byte 相对帧起点的偏移（192 ATSC 前导时为 4，其余为 0）。 */
  syncOffset: number;
  reason: string;
}

/** 在缓冲区中判断封装大小并定位首个完整帧。
 * 188：裸 MPEG-TS；192：帧起点 + 4 字节 ATSC 前导 + 188；204：188 + 16 字节 RS。 */
export function detectFrameSize(buf: Uint8Array): FrameDetectResult {
  const candidates: Array<{ frameSize: FrameSize; syncOffset: number }> = [
    { frameSize: 188, syncOffset: 0 },
    { frameSize: 204, syncOffset: 0 },
    { frameSize: 192, syncOffset: 4 },
  ];
  for (let leader = 0; leader < 208; leader++) {
    for (const { frameSize, syncOffset } of candidates) {
      if (leader + syncOffset + frameSize > buf.length) continue;
      const need = Math.min(5, Math.floor((buf.length - leader) / frameSize));
      if (need < 2) continue;
      let valid = true;
      for (let k = 0; k < need; k++) {
        if (buf[leader + k * frameSize + syncOffset] !== SYNC_BYTE) {
          valid = false;
          break;
        }
      }
      if (valid) {
        return {
          frameSize,
          skippedLeader: leader,
          syncOffset,
          reason:
            frameSize === 188
              ? 'sync byte 每 188 字节重复：裸 MPEG-TS'
              : frameSize === 192
                ? 'sync byte 每 192 字节、帧内偏移 4：ATSC 4 字节时间码前导'
                : 'sync byte 每 204 字节重复：188 + 16 字节 Reed-Solomon 尾',
        };
      }
    }
  }
  throw new Error('无法定位 0x47 同步字节，输入不是 MPEG transport stream（188/192/204）');
}

/** 同步并切出全部 188 字节 packet（末尾不足一帧忽略并计数）。 */
export function splitPackets(buf: Uint8Array): {
  frameSize: FrameSize;
  skippedLeader: number;
  reason: string;
  packets: TsPacket[];
  inputBytes: number;
  trailing: number;
} {
  const det = detectFrameSize(buf);
  const packets: TsPacket[] = [];
  let arrivalIndex = 0;
  for (let pos = det.skippedLeader; pos + det.frameSize <= buf.length; pos += det.frameSize) {
    const frame = buf.subarray(pos, pos + det.frameSize);
    if (frame[det.syncOffset] !== SYNC_BYTE) {
      throw new Error(`第 ${arrivalIndex} 帧（偏移 ${pos}）同步字节丢失，流在此截断`);
    }
    const prefixLen = det.syncOffset;
    const prefixBytes = frame.slice(0, prefixLen);
    const ts = frame.slice(prefixLen, prefixLen + TS_PACKET_SIZE);
    packets.push(parsePacket(ts, arrivalIndex, det.frameSize, prefixBytes, frame));
    arrivalIndex++;
  }
  const consumed = det.skippedLeader + packets.length * det.frameSize;
  return {
    frameSize: det.frameSize,
    skippedLeader: det.skippedLeader,
    reason: det.reason,
    packets,
    inputBytes: buf.length,
    trailing: buf.length - consumed,
  };
}

function parsePacket(
  ts: Uint8Array,
  arrivalIndex: number,
  frameSize: FrameSize,
  prefixBytes: Uint8Array,
  frame: Uint8Array,
): TsPacket {
  const w1 = (ts[1]! << 16) | (ts[2]! << 8) | ts[3]!;
  const tei = ((w1 >> 23) & 1) === 1;
  const payloadUnitStartIndicator = ((w1 >> 22) & 1) === 1;
  const priority = ((w1 >> 21) & 1) === 1;
  const pid = w1 & 0x1fff;
  const scrambling = (ts[3]! >> 6) & 0x3;
  const adaptationFieldControl = (ts[3]! >> 4) & 0x3;
  const continuityCounter = ts[3]! & 0x0f;

  let adaptation: AdaptationField | null = null;
  let payload: { offset: number; length: number } | null = null;

  if (
    adaptationFieldControl === AFC_ADAPTATION_ONLY ||
    adaptationFieldControl === AFC_ADAPTATION_AND_PAYLOAD
  ) {
    adaptation = parseAdaptationField(ts);
  }
  if (adaptationFieldControl === AFC_ADAPTATION_AND_PAYLOAD) {
    const start = adaptation && adaptation.length > 0 ? 5 + adaptation.length : 5;
    if (start <= TS_PACKET_SIZE) {
      payload = { offset: start, length: TS_PACKET_SIZE - start };
    }
  } else if (adaptationFieldControl === 1) {
    payload = { offset: 4, length: 184 };
  }

  return {
    arrivalIndex,
    frameSize,
    prefixBytes,
    frame,
    ts,
    tei,
    payloadUnitStartIndicator,
    priority,
    pid,
    scrambling,
    adaptationFieldControl,
    continuityCounter,
    payload,
    adaptation,
  };
}

function parseAdaptationField(ts: Uint8Array): AdaptationField {
  const length = ts[4]!;
  const af: AdaptationField = {
    length,
    discontinuityIndicator: false,
    randomAccessIndicator: false,
    elementaryStreamPriorityIndicator: false,
    pcrFlag: false,
    opcrFlag: false,
    splicingPointFlag: false,
    transportPrivateDataFlag: false,
    adaptationFieldExtensionFlag: false,
    pcr: null,
    opcr: null,
    spliceCountdown: null,
    privateDataBytes: null,
    stuffingBytes: 0,
  };
  if (length === 0) return af;

  const flags = ts[5]!;
  af.discontinuityIndicator = (flags & 0x80) !== 0;
  af.randomAccessIndicator = (flags & 0x40) !== 0;
  af.elementaryStreamPriorityIndicator = (flags & 0x20) !== 0;
  af.pcrFlag = (flags & 0x10) !== 0;
  af.opcrFlag = (flags & 0x08) !== 0;
  af.splicingPointFlag = (flags & 0x04) !== 0;
  af.transportPrivateDataFlag = (flags & 0x02) !== 0;
  af.adaptationFieldExtensionFlag = (flags & 0x01) !== 0;

  let cursor = 6;
  const afEnd = Math.min(4 + length, TS_PACKET_SIZE);
  if (af.pcrFlag && cursor + 6 <= afEnd) {
    af.pcr = readPcr(ts, cursor);
    cursor += 6;
  }
  if (af.opcrFlag && cursor + 6 <= afEnd) {
    af.opcr = readPcr(ts, cursor);
    cursor += 6;
  }
  if (af.splicingPointFlag && cursor < afEnd) {
    af.spliceCountdown = ts[cursor] ?? null;
    cursor += 1;
  }
  if (af.transportPrivateDataFlag && cursor < afEnd) {
    const n = ts[cursor]!;
    af.privateDataBytes = n;
    cursor += 1 + n;
  }
  if (af.adaptationFieldExtensionFlag && cursor < afEnd) {
    const extLen = ts[cursor]!;
    cursor += 1 + extLen;
  }
  if (cursor < afEnd) af.stuffingBytes = afEnd - cursor;
  return af;
}

function readPcr(ts: Uint8Array, offset: number): PcrValue {
  const p = parsePcr(ts, offset);
  return { raw: p.raw, base: p.base, extension: p.extension };
}
