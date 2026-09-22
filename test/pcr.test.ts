import { describe, expect, it } from 'vitest';
import { unwrapPcr } from '../src/core/mpeg.js';

describe('PCR 回绕展开', () => {
  const wrap = (1n << 33n) * 300n;

  it('单调序列原样保留', () => {
    const raw = [1000n, 2000n, 3000n];
    expect(unwrapPcr(raw, raw.map((r) => r / 300n))).toEqual(raw);
  });

  it('2^33 base 回绕被加上整圈，保持单调', () => {
    const raw = [wrap - 2000n, 3000n];
    const out = unwrapPcr(raw, raw.map((r) => r / 300n));
    expect(out[1]).toBe(wrap + 3000n);
    expect(out[1]! > out[0]!).toBe(true);
  });

  it('回绕后的 delta 等于实际小步进', () => {
    const raw = [wrap - 2000n, 3000n, 3300n];
    const out = unwrapPcr(raw, raw.map((r) => r / 300n));
    expect(out[1]! - out[0]!).toBe(5000n);
    expect(out[2]! - out[1]!).toBe(300n);
  });

  it('半圈以内的真实回退不被当作回绕（不会乱加圈）', () => {
    const raw = [1_000_000n, 900_000n];
    const out = unwrapPcr(raw, raw.map((r) => r / 300n));
    expect(out[1]).toBe(900_000n);
  });
});
