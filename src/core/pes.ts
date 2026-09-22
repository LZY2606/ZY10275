/** PES 解析（只在 PMT 已声明的 ES PID 上进行，unknown stream type 同样保留）。 */

import type { PesInfo, TimelineEvent, TsPacket } from './types.js';

const STREAM_ID_HAS_HEADER = (id: number): boolean =>
  // 13818-1: program_stream_map / padding / private2 / ECM / EMM / program stream directory / DSMCC 之外
  !(id === 0xbc || id === 0xbe || id === 0xbf || (id >= 0xf0 && id <= 0xf2) || id === 0xff);

function parseTimestamp(data: Uint8Array, offset: number): number | null {
  if (offset + 5 > data.length) return null;
  const b0 = data[offset]!;
  const b1 = data[offset + 1]!;
  const b2 = data[offset + 2]!;
  const b3 = data[offset + 3]!;
  const b4 = data[offset + 4]!;
  return ((((b0 >>> 1) & 0x07) << 30) | (b1 << 22) | ((b2 >>> 1) << 15) | (b3 << 7) | (b4 >>> 1)) >>> 0;
}

export function parsePesPackets(
  packets: readonly TsPacket[],
  elementaryPids: ReadonlySet<number>,
): { pes: PesInfo[]; events: TimelineEvent[] } {
  const pes: PesInfo[] = [];
  const events: TimelineEvent[] = [];

  for (const p of packets) {
    if (!p.payloadUnitStartIndicator || !p.payload) continue;
    if (!elementaryPids.has(p.pid)) continue;
    const off = p.payload.offset;
    const ts = p.ts;
    if (ts[off] !== 0x00 || ts[off + 1] !== 0x00 || ts[off + 2] !== 0x01) continue;
    const streamId = ts[off + 3]!;
    const length = (ts[off + 4]! << 8) | ts[off + 5]!;
    let dataOffset = off + 6;
    let dataLength = p.payload.length - 6;
    let pts: number | null = null;
    let dts: number | null = null;
    let scrambled = false;
    if (STREAM_ID_HAS_HEADER(streamId) && off + 9 <= ts.length) {
      const ptsDtsFlags = (ts[off + 7]! >> 6) & 0x3;
      const headerDataLen = ts[off + 8]!;
      const hStart = off + 9;
      dataOffset = hStart + headerDataLen;
      dataLength = p.payload.offset + p.payload.length - dataOffset;
      scrambled = (p.scrambling & 0x2) !== 0;
      if (ptsDtsFlags === 2 || ptsDtsFlags === 3) pts = parseTimestamp(ts, hStart);
      if (ptsDtsFlags === 3) dts = parseTimestamp(ts, hStart + 5);
    }
    pes.push({
      packetIndex: p.arrivalIndex,
      pid: p.pid,
      streamId,
      length,
      pts,
      dts,
      dataOffset,
      dataLength: Math.max(0, dataLength),
      scrambled,
    });
    events.push({
      packetIndex: p.arrivalIndex,
      pid: p.pid,
      kind: 'pes',
      message: `PES start stream_id=0x${streamId.toString(16).padStart(2, '0')}${pts !== null ? ` PTS=${pts}` : ''}${
        dts !== null ? ` DTS=${dts}` : ''
      }`,
      detail: { streamId, length, pts, dts, scrambled },
    });
  }
  return { pes, events };
}
