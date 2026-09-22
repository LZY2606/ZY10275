/** 端到端分析编排：严格按 packet 到达顺序推进，所有归属都取“当刻生效”的节目表。 */

import { analyzeContinuity } from './continuity.js';
import { KNOWN_STREAM_TYPES, unwrapPcr } from './mpeg.js';
import { splitPackets } from './packet.js';
import { parsePesPackets } from './pes.js';
import { reassembleSections } from './section.js';
import { buildTableState, patAt, pmtAt } from './tables.js';
import type {
  AnalysisResult,
  MappingSnapshot,
  TimelineEvent,
  TsPacket,
} from './types.js';

export interface AnalyzeOptions {
  frameSizeHint?: 188 | 192 | 204;
}

export interface PcrTimelinePoint {
  packetIndex: number;
  pid: number;
  programNumber: number | null;
  raw: string;
  base: string;
  extension: number;
  unwrapped: string;
  deltaFromPrev: string | null;
  discontinuity: boolean;
  kind: 'pcr' | 'opcr';
}

export function analyzeBuffer(buf: Uint8Array): AnalysisResult & {
  frameReason: string;
  trailing: number;
  pcrTimeline: PcrTimelinePoint[];
} {
  const split = splitPackets(buf);
  return analyzePackets(split.packets, split.frameSize, split.inputBytes, split.skippedLeader, split.reason, split.trailing);
}

export function analyzePackets(
  packets: TsPacket[],
  frameSize: 188 | 192 | 204,
  inputBytes: number,
  skippedLeader: number,
  frameReason: string,
  trailing: number,
): AnalysisResult & { frameReason: string; trailing: number; pcrTimeline: PcrTimelinePoint[] } {
  const { sections, issues } = reassembleSections(packets);
  const { patGenerations, pmtGenerations, events: tableEvents } = buildTableState(
    sections,
    issues,
    KNOWN_STREAM_TYPES,
  );
  const ccEvents = analyzeContinuity(packets);
  const { pes, events: pesEvents } = parsePesPackets(packets, collectElementaryPids(pmtGenerations));

  const events: TimelineEvent[] = [];
  const pcrByPid = new Map<number, { raw: bigint[]; base: bigint[]; points: PcrTimelinePoint[] }>();

  const ownership = (pid: number, index: number): { programNumber: number; role: 'pmt' | 'elementary' | 'pcr'; streamType: number | null } | null => {
    const pat = patAt(patGenerations, index);
    if (!pat) return null;
    for (const entry of pat.entries) {
      if (entry.programNumber === 0) continue;
      if (entry.pmtPid === pid) return { programNumber: entry.programNumber, role: 'pmt', streamType: null };
      const pmt = pmtAt(pmtGenerations, entry.programNumber, index);
      if (!pmt) continue;
      if (pmt.pcrPid === pid) {
        const stream = pmt.streams.find((s) => s.pid === pid);
        return { programNumber: entry.programNumber, role: 'pcr', streamType: stream?.streamType ?? null };
      }
      const stream = pmt.streams.find((s) => s.pid === pid);
      if (stream) return { programNumber: entry.programNumber, role: 'elementary', streamType: stream.streamType };
    }
    return null;
  };

  for (const p of packets) {
    if (p.tei) {
      events.push({
        packetIndex: p.arrivalIndex,
        pid: p.pid,
        kind: 'tei',
        message: `PID 0x${p.pid.toString(16).padStart(4, '0')} transport_error_indicator=1（保留现场，不静默丢弃）`,
        detail: { cc: p.continuityCounter },
      });
    }
    const af = p.adaptation;
    if (af && (af.pcr || af.opcr)) {
      const owner = ownership(p.pid, p.arrivalIndex);
      for (const [kind, v] of [
        ['pcr', af.pcr],
        ['opcr', af.opcr],
      ] as const) {
        if (!v) continue;
        let series = pcrByPid.get(p.pid);
        if (!series) {
          series = { raw: [], base: [], points: [] };
          pcrByPid.set(p.pid, series);
        }
        series.raw.push(v.raw);
        series.base.push(v.base);
        series.points.push({
          packetIndex: p.arrivalIndex,
          pid: p.pid,
          programNumber: owner?.programNumber ?? null,
          raw: v.raw.toString(),
          base: v.base.toString(),
          extension: v.extension,
          unwrapped: '0',
          deltaFromPrev: null,
          discontinuity: af.discontinuityIndicator,
          kind,
        });
        events.push({
          packetIndex: p.arrivalIndex,
          pid: p.pid,
          kind,
          message: `${kind.toUpperCase()} PID 0x${p.pid.toString(16).padStart(4, '0')}${
            owner ? ` → program ${owner.programNumber}` : '（当刻无节目归属）'
          } raw=${v.raw}${af.discontinuityIndicator ? ' DI=1' : ''}`,
          detail: {
            raw: v.raw.toString(),
            base: v.base.toString(),
            extension: v.extension,
            programNumber: owner?.programNumber ?? null,
            discontinuity: af.discontinuityIndicator,
          },
        });
      }
    }
  }

  // 每个 PID 独立展开 PCR 回绕；DI 点之后重新锚定，避免把跳变当回绕。
  const pcrTimeline: PcrTimelinePoint[] = [];
  for (const series of pcrByPid.values()) {
    let segmentRaw: bigint[] = [];
    let segmentBase: bigint[] = [];
    let segmentPoints: PcrTimelinePoint[] = [];
    const flush = (): void => {
      if (segmentPoints.length === 0) return;
      const unwrapped = unwrapPcr(segmentRaw, segmentBase);
      let prev: bigint | null = null;
      unwrapped.forEach((u, i) => {
        const point = segmentPoints[i]!;
        point.unwrapped = u.toString();
        point.deltaFromPrev = prev === null ? null : (u - prev).toString();
        prev = u;
      });
      pcrTimeline.push(...segmentPoints);
      segmentRaw = [];
      segmentBase = [];
      segmentPoints = [];
    };
    for (let i = 0; i < series.points.length; i++) {
      if (series.points[i]!.discontinuity && segmentPoints.length > 0) flush();
      segmentRaw.push(series.raw[i]!);
      segmentBase.push(series.base[i]!);
      segmentPoints.push(series.points[i]!);
    }
    flush();
  }
  pcrTimeline.sort((a, b) => a.packetIndex - b.packetIndex || (a.kind === 'pcr' ? -1 : 1));

  events.push(...tableEvents, ...ccEvents, ...pesEvents, ...issuesAsEvents(issues));
  events.sort((a, b) => a.packetIndex - b.packetIndex || eventRank(a.kind) - eventRank(b.kind));

  const pidSet = new Set<number>(packets.map((p) => p.pid));

  return {
    frameSize,
    frameReason,
    packetCount: packets.length,
    packets,
    sections,
    patGenerations,
    pmtGenerations,
    issues,
    events,
    pes,
    pids: [...pidSet].sort((a, b) => a - b),
    inputBytes,
    skippedLeader,
    trailing,
    pcrTimeline,
  };
}

function eventRank(k: TimelineEvent['kind']): number {
  const order: TimelineEvent['kind'][] = [
    'pat-generation',
    'pmt-generation',
    'rollback',
    'program-switch',
    'psi',
    'psi-error',
    'pcr',
    'opcr',
    'discontinuity',
    'pes',
    'cc-gap',
    'cc-reorder',
    'cc-duplicate',
    'adaptation-only',
    'tei',
  ];
  return order.indexOf(k);
}

function issuesAsEvents(issues: AnalysisResult['issues']): TimelineEvent[] {
  return issues.map((i) => ({
    packetIndex: i.packetIndex,
    pid: i.pid,
    kind: 'psi-error',
    message: `PSI 重组错误：${i.reason}`,
    detail: { ...i },
  }));
}

export function collectElementaryPids(pmts: AnalysisResult['pmtGenerations']): Set<number> {
  const out = new Set<number>();
  for (const g of pmts) for (const s of g.streams) out.add(s.pid);
  return out;
}

/** 求任意 packet 当刻的 PID → 节目映射（停帧审阅）。 */
export function mappingAt(result: AnalysisResult, packetIndex: number): MappingSnapshot {
  const pat = patAt(result.patGenerations, packetIndex);
  const programs: MappingSnapshot['programs'] = [];
  const pidOwnership: MappingSnapshot['pidOwnership'] = {};
  if (pat) {
    for (const entry of pat.entries) {
      if (entry.programNumber === 0) {
        pidOwnership[toHexPid(entry.pmtPid)] = null; // network PID：不属于任何节目
        continue;
      }
      pidOwnership[toHexPid(entry.pmtPid)] = {
        programNumber: entry.programNumber,
        role: 'pmt',
        streamType: null,
      };
      const pmt = pmtAt(result.pmtGenerations, entry.programNumber, packetIndex);
      if (!pmt) continue;
      programs.push({
        programNumber: entry.programNumber,
        patVersion: pat.version,
        pmtVersion: pmt.version,
        pcrPid: pmt.pcrPid,
        streams: pmt.streams,
      });
      pidOwnership[toHexPid(pmt.pcrPid)] = {
        programNumber: entry.programNumber,
        role: 'pcr',
        streamType: pmt.streams.find((s) => s.pid === pmt.pcrPid)?.streamType ?? null,
      };
      for (const s of pmt.streams) {
        pidOwnership[toHexPid(s.pid)] = {
          programNumber: entry.programNumber,
          role: 'elementary',
          streamType: s.streamType,
        };
      }
    }
  }
  // 出现过但当刻无映射的 PID 显式给 null，便于发现“节目表外”流量。
  for (const p of result.packets) {
    if (p.arrivalIndex > packetIndex) break;
    const key = toHexPid(p.pid);
    if (!(key in pidOwnership)) pidOwnership[key] = null;
  }
  return { packetIndex, programs, pidOwnership };
}

export function toHexPid(pid: number): string {
  return `0x${pid.toString(16).padStart(4, '0')}`;
}
