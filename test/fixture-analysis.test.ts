import { describe, expect, it } from 'vitest';
import { analyzeBuffer, mappingAt } from '../src/core/analyzer.js';
import {
  buildFixtureStream,
  encodeFrames,
  PID_AUDIO,
  PID_PMT_1,
  PID_UNKNOWN,
  PID_VIDEO,
  PID_VIDEO2,
} from '../src/core/fixture.js';
import { TABLE_ID_PAT, TABLE_ID_PMT } from '../src/core/mpeg.js';

function analyze() {
  const fx = buildFixtureStream();
  const result = analyzeBuffer(encodeFrames(fx.packets, 188));
  return { fx, result };
}

describe('PSI 重组：跨包 / pointer / CRC', () => {
  it('PMT v2 long section 恰好跨三个 packet 且 pointer_field=0', () => {
    const { fx, result } = analyze();
    const span = fx.marks.crossThreePacketSection;
    expect(span.packets).toHaveLength(3);
    const section = result.sections.find(
      (s) => s.startPacket === span.start && s.tableId === TABLE_ID_PMT,
    )!;
    expect(section).toBeTruthy();
    expect(section.carriedPackets).toEqual(span.packets);
    expect(section.endPacket).toBe(span.end);
    expect(section.pointerField).toBe(0);
    expect(section.totalLength).toBeGreaterThan(2 * 183);
    expect(section.crcValid).toBe(true);
  });

  it('坏 CRC section 被记录但不产生 PMT v3 代次', () => {
    const { fx, result } = analyze();
    const bad = result.sections.find((s) => s.startPacket === fx.marks.pmtV3BadCrcStart)!;
    expect(bad).toBeTruthy();
    expect(bad.version).toBe(3);
    expect(bad.crcValid).toBe(false);
    expect(result.pmtGenerations.some((g) => g.programNumber === 1 && g.version === 3)).toBe(false);
    expect(result.issues.some((i) => i.crcValid === false && i.pid === PID_PMT_1)).toBe(true);
  });

  it('错误 section 不污染上一代可用映射：坏 CRC 后仍是 v2，回滚后恢复 v1', () => {
    const { fx, result } = analyze();
    const afterBad = mappingAt(result, fx.marks.pmtV3BadCrcStart + 1);
    const p1afterBad = afterBad.programs.find((p) => p.programNumber === 1)!;
    expect(p1afterBad.pmtVersion).toBe(2);
    expect(p1afterBad.streams.some((s) => s.pid === PID_UNKNOWN)).toBe(true);

    const afterRollback = mappingAt(result, fx.marks.pmtV1RollbackStart + 1);
    const p1rb = afterRollback.programs.find((p) => p.programNumber === 1)!;
    expect(p1rb.pmtVersion).toBe(1);
    expect(p1rb.streams.some((s) => s.pid === PID_UNKNOWN)).toBe(false);
  });
});

describe('PAT/PMT 代次边界与版本回滚', () => {
  it('PAT 两代：v1 一节目，v2 两节目，program-switch 事件归属正确', () => {
    const { result } = analyze();
    const pats = result.patGenerations;
    expect(pats.map((g) => g.version)).toEqual([1, 2]);
    expect(pats[0]!.entries.filter((e) => e.programNumber !== 0)).toHaveLength(1);
    expect(pats[1]!.entries.filter((e) => e.programNumber !== 0)).toHaveLength(2);
    const switches = result.events.filter((e) => e.kind === 'program-switch');
    expect(switches.some((e) => String(e.detail.change) === 'added' && e.detail.programNumber === 2)).toBe(true);
    expect(switches.some((e) => String(e.detail.change) === 'removed')).toBe(false);
  });

  it('PMT program 1 版本序列为 v1 -> v2 -> v1，末代 rolledBack=true', () => {
    const { result } = analyze();
    const gens = result.pmtGenerations.filter((g) => g.programNumber === 1);
    expect(gens.map((g) => g.version)).toEqual([1, 2, 1]);
    expect(gens[0]!.rolledBack).toBe(false);
    expect(gens[1]!.rolledBack).toBe(false);
    expect(gens[2]!.rolledBack).toBe(true);
    const rollbacks = result.events.filter((e) => e.kind === 'rollback');
    expect(rollbacks.some((e) => e.pid === PID_PMT_1)).toBe(true);
  });

  it('代次 endPacket 与下一代 startPacket 边界相邻（不含重叠/空洞语义）', () => {
    const { result } = analyze();
    const gens = result.pmtGenerations.filter((g) => g.programNumber === 1);
    expect(gens[0]!.endPacket).toBe(gens[1]!.startPacket - 1);
    expect(gens[1]!.endPacket).toBe(gens[2]!.startPacket - 1);
    expect(gens[2]!.endPacket).toBeNull();
  });

  it('切换前看不到 program 2；切换后可见且 PMT v0', () => {
    const { fx, result } = analyze();
    const before = mappingAt(result, fx.marks.patV2Start - 1);
    expect(before.programs.some((p) => p.programNumber === 2)).toBe(false);
    const afterPmt = mappingAt(result, fx.marks.pmt2Start + 1);
    const p2 = afterPmt.programs.find((p) => p.programNumber === 2)!;
    expect(p2).toBeTruthy();
    expect(p2.pmtVersion).toBe(0);
    expect(p2.streams[0]!.pid).toBe(PID_VIDEO2);
  });
});

describe('未知 stream type 保留原值与 descriptor', () => {
  it('0x57 未在已知集合中，但 streamType 与私有 descriptor 原样保留', () => {
    const { result } = analyze();
    const v2 = result.pmtGenerations.find((g) => g.programNumber === 1 && g.version === 2)!;
    const unknown = v2.streams.find((s) => s.pid === PID_UNKNOWN)!;
    expect(unknown.streamType).toBe(0x57);
    expect(unknown.knownType).toBe(false);
    expect(unknown.descriptors).toHaveLength(1);
    expect(unknown.descriptors[0]!.tag).toBe(0xc3);
    expect([...unknown.descriptors[0]!.data]).toEqual([0xde, 0xad]);
  });
});

describe('连续计数：payload 递增、合法重复 vs 真实丢包、乱序、DI 隔离', () => {
  it('合法重复 payload 标记 cc-duplicate 而非缺口', () => {
    const { fx, result } = analyze();
    const { first, second, pid } = fx.marks.duplicatePayload;
    expect(first).toBeLessThan(second);
    const dup = result.events.find((e) => e.kind === 'cc-duplicate' && e.packetIndex === second);
    expect(dup).toBeTruthy();
    expect(dup!.pid).toBe(pid);
    expect(result.events.some((e) => e.kind === 'cc-gap' && e.packetIndex === second)).toBe(false);
  });

  it('只含 adaptation 的包不递增 CC，且被标 adaptation-only', () => {
    const { fx, result } = analyze();
    const ev = result.events.find(
      (e) => e.kind === 'adaptation-only' && e.packetIndex === fx.marks.adaptationOnly.index,
    );
    expect(ev).toBeTruthy();
    const before = result.packets
      .filter((p) => p.pid === PID_VIDEO && p.payload && p.arrivalIndex < fx.marks.adaptationOnly.index)
      .at(-1)!;
    const after = result.packets.find(
      (p) => p.pid === PID_VIDEO && p.payload && p.arrivalIndex > fx.marks.adaptationOnly.index,
    )!;
    expect((after.continuityCounter - before.continuityCounter + 16) % 16).toBe(1);
  });

  it('真实缺口归因到视频 PID，missing=2，且不波及其它 PID', () => {
    const { fx, result } = analyze();
    const gap = result.events.find((e) => e.kind === 'cc-gap' && e.packetIndex === fx.marks.ccGap.index)!;
    expect(gap).toBeTruthy();
    expect(gap.pid).toBe(PID_VIDEO);
    expect(gap.detail.missing).toBe(2);
    // 音频 PID 上同一时刻没有 gap
    expect(
      result.events.some(
        (e) => e.kind === 'cc-gap' && e.pid === PID_AUDIO && Math.abs(e.packetIndex - fx.marks.ccGap.index) <= 2,
      ),
    ).toBe(false);
  });

  it('乱序到达标 cc-reorder，不算丢包', () => {
    const { fx, result } = analyze();
    const reorder = result.events.find(
      (e) => e.kind === 'cc-reorder' && e.packetIndex === fx.marks.reorder.later,
    );
    expect(reorder).toBeTruthy();
    expect(reorder!.detail.from).toBe(8);
    expect(reorder!.detail.to).toBe(7);
    expect(result.events.some((e) => e.kind === 'cc-gap' && e.packetIndex === fx.marks.reorder.later)).toBe(false);
  });

  it('discontinuity 只重置该 PID：音频 DI 后 CC 跳变合法，视频不受影响', () => {
    const { fx, result } = analyze();
    const di = result.events.find(
      (e) => e.kind === 'discontinuity' && e.packetIndex === fx.marks.discontinuity.index,
    );
    expect(di).toBeTruthy();
    expect(di!.pid).toBe(PID_AUDIO);
    // DI 之后音频的下一个 payload CC 与历史不连续，但不产生 gap
    expect(
      result.events.some(
        (e) =>
          e.kind === 'cc-gap' &&
          e.pid === PID_AUDIO &&
          e.packetIndex > fx.marks.discontinuity.index &&
          e.packetIndex <= fx.marks.reorder.earlier,
      ),
    ).toBe(false);
  });
});

describe('PCR/OPCR：回绕展开、节目归属、DI 分段', () => {
  it('PCR 回绕后 unwrapped 保持单调，delta 为小步进', () => {
    const { fx, result } = analyze();
    const points = result.pcrTimeline
      .filter((p) => p.pid === PID_VIDEO && p.kind === 'pcr')
      .sort((a, b) => a.packetIndex - b.packetIndex);
    const before = points.find((p) => p.packetIndex === fx.marks.pcrWrap.beforeIndex)!;
    const after = points.find((p) => p.packetIndex === fx.marks.pcrWrap.afterIndex)!;
    expect(BigInt(after.unwrapped)).toBeGreaterThan(BigInt(before.unwrapped));
    expect(BigInt(after.deltaFromPrev!)).toBeGreaterThan(0n);
    expect(BigInt(after.deltaFromPrev!)).toBeLessThan(10_000n);
  });

  it('每个 PCR 点都归属到当刻生效节目（program 1 / 2）', () => {
    const { result } = analyze();
    const p1 = result.pcrTimeline.filter((p) => p.pid === PID_VIDEO);
    expect(p1.length).toBeGreaterThan(0);
    expect(p1.every((p) => p.programNumber === 1)).toBe(true);
    const p2 = result.pcrTimeline.filter((p) => p.pid === PID_VIDEO2);
    expect(p2.every((p) => p.programNumber === 2)).toBe(true);
  });
});

describe('停帧映射 mappingAt', () => {
  it('首个 PAT 之前无任何节目；PAT 后 PMT 前只见 PMT PID 不见 ES', () => {
    const { fx, result } = analyze();
    const before = mappingAt(result, fx.marks.patV1Start - 1);
    expect(before.programs).toHaveLength(0);
    const between = mappingAt(result, fx.marks.pmtV1Start - 1);
    expect(between.pidOwnership['0x0100']?.role).toBe('pmt');
    expect(between.programs).toHaveLength(0);
  });

  it('network PID 0x0010 显式无归属，节目外流量可见为 null', () => {
    const { fx, result } = analyze();
    const m = mappingAt(result, fx.marks.pmtV1Start + 1);
    expect(m.pidOwnership['0x0010']).toBeNull();
  });

  it('所有时间线事件按 packet 顺序，绝不按 PID 排序掩盖回绕/切换', () => {
    const { result } = analyze();
    const seq = result.events.map((e) => e.packetIndex);
    const sorted = [...seq].sort((a, b) => a - b);
    expect(seq).toEqual(sorted);
    // PAT section 的 table id
    expect(result.sections.some((s) => s.tableId === TABLE_ID_PAT)).toBe(true);
  });
});
