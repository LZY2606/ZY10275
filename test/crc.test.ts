import { describe, expect, it } from 'vitest';
import { crc32Mpeg2 } from '../src/core/crc.js';

describe('CRC-32/MPEG-2', () => {
  it('空输入为 0xFFFFFFFF', () => {
    expect(crc32Mpeg2(new Uint8Array(0))).toBe(0xffffffff);
  });

  it('全零 4 字节向量', () => {
    // 业界常用 MPEG-2 CRC 向量：四个 0x00 -> 0x02018EF9
    expect(crc32Mpeg2(new Uint8Array([0, 0, 0, 0]))).toBe(0x02018ef9);
  });

  it('"123456789" 向量为 0x0376E6E7', () => {
    expect(crc32Mpeg2(new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57]))).toBe(0x0376e6e7);
  });

  it('section 自校验：附在尾部的 CRC 使整体 CRC 归零', () => {
    const body = new Uint8Array([0x02, 0xb0, 0x11, 0x00, 0x01, 0xc3, 0, 0, 0xe1, 0x01, 0xf0, 0x00]);
    const crc = crc32Mpeg2(body, 0, body.length);
    const section = new Uint8Array(body.length + 4);
    section.set(body, 0);
    section[body.length] = (crc >>> 24) & 0xff;
    section[body.length + 1] = (crc >>> 16) & 0xff;
    section[body.length + 2] = (crc >>> 8) & 0xff;
    section[body.length + 3] = crc & 0xff;
    expect(crc32Mpeg2(section, 1, section.length)).toBe(0);
  });
});
