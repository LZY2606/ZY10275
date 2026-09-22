import { describe, expect, it } from 'vitest';
import { detectFrameSize, splitPackets } from '../src/core/packet.js';
import { buildFixtureStream, encodeFrames } from '../src/core/fixture.js';
import { SYNC_BYTE } from '../src/core/mpeg.js';

describe('封装判断 188/192/204', () => {
  const logical = buildFixtureStream();

  for (const size of [188, 192, 204] as const) {
    it(`${size} 字节封装可被检测并切出相同包数`, () => {
      const buf = encodeFrames(logical.packets, size);
      const det = detectFrameSize(buf);
      expect(det.frameSize).toBe(size);
      const split = splitPackets(buf);
      expect(split.packets).toHaveLength(logical.packets.length);
      expect(split.packets[0]!.ts[0]).toBe(SYNC_BYTE);
    });
  }

  it('192 字节封装保留 4 字节 ATSC 前导', () => {
    const buf = encodeFrames(logical.packets, 192);
    const split = splitPackets(buf);
    expect(split.packets[0]!.prefixBytes).toHaveLength(4);
    expect(split.packets[0]!.prefixBytes[3]).toBe(0);
    expect(split.packets[1]!.prefixBytes[3]).toBe(1);
    expect(split.packets[0]!.frame[4]).toBe(SYNC_BYTE);
  });

  it('204 字节封装保留 16 字节 RS 尾且 ts 体仍是 188', () => {
    const buf = encodeFrames(logical.packets, 204);
    const split = splitPackets(buf);
    expect(split.packets[0]!.ts).toHaveLength(188);
    expect(split.packets[0]!.frame[188]).toBe(0); // i=0,j=0 -> 0
  });

  it('前导垃圾字节可跳过并记录 skippedLeader', () => {
    const buf = encodeFrames(logical.packets, 188);
    const withLeader = new Uint8Array(buf.length + 7);
    withLeader.set([1, 2, 3, 4, 5, 6, 7], 0);
    withLeader.set(buf, 7);
    const split = splitPackets(withLeader);
    expect(split.skippedLeader).toBe(7);
    expect(split.packets).toHaveLength(logical.packets.length);
  });

  it('原始 packet 序号即 arrivalIndex，乱序也不重排', () => {
    const buf = encodeFrames(logical.packets, 188);
    const split = splitPackets(buf);
    split.packets.forEach((p, i) => expect(p.arrivalIndex).toBe(i));
  });
});
