/** PAT / PMT 解析与代次（generation）维护。
 *
 * 规则：
 * - 只有 current_next_indicator=1 且 CRC 正确的 section 才能生成新一代；
 * - 待生效（next）section 与 CRC 错误的 section 仅审计，绝不污染现行映射；
 * - version 变化按 mod-32 前向距离判定方向，距离 > 16 记为回滚（rollback）；
 * - 每个 program 的 PMT 独立维护代次；PAT 新增/移除节目产生 program-switch 事件。
 */

import { TABLE_ID_PAT, TABLE_ID_PMT, versionForwardDistance } from './mpeg.js';
import type {
  Descriptor,
  ElementaryStream,
  PatEntry,
  PatGeneration,
  PmtGeneration,
  PsiSection,
  SectionIssue,
  TimelineEvent,
} from './types.js';

export function parseDescriptors(data: Uint8Array, start: number, end: number): Descriptor[] {
  const out: Descriptor[] = [];
  let cursor = start;
  while (cursor + 2 <= end) {
    const tag = data[cursor]!;
    const len = data[cursor + 1]!;
    if (cursor + 2 + len > end) break;
    out.push({ tag, data: data.slice(cursor + 2, cursor + 2 + len) });
    cursor += 2 + len;
  }
  return out;
}

export function parsePat(section: PsiSection): PatEntry[] {
  const d = section.data;
  const end = d.length - 4; // 去 CRC
  const entries: PatEntry[] = [];
  let cursor = 8;
  while (cursor + 4 <= end) {
    const programNumber = (d[cursor]! << 8) | d[cursor + 1]!;
    const pid = ((d[cursor + 2]! & 0x1f) << 8) | d[cursor + 3]!;
    entries.push({ programNumber, pmtPid: pid });
    cursor += 4;
  }
  return entries;
}

export interface PmtBody {
  pcrPid: number;
  programInfoDescriptors: Descriptor[];
  streams: ElementaryStream[];
}

export function parsePmt(section: PsiSection, knownTypes: ReadonlySet<number>): PmtBody {
  const d = section.data;
  const end = d.length - 4;
  const pcrPid = ((d[8]! & 0x1f) << 8) | d[9]!;
  const piLen = ((d[10]! & 0x0f) << 8) | d[11]!;
  const programInfoDescriptors = parseDescriptors(d, 12, 12 + piLen);
  const streams: ElementaryStream[] = [];
  let cursor = 12 + piLen;
  while (cursor + 5 <= end) {
    const streamType = d[cursor]!;
    const pid = ((d[cursor + 1]! & 0x1f) << 8) | d[cursor + 2]!;
    const esInfoLen = ((d[cursor + 3]! & 0x0f) << 8) | d[cursor + 4]!;
    const descEnd = cursor + 5 + esInfoLen;
    const descriptors = parseDescriptors(d, cursor + 5, descEnd);
    streams.push({
      streamType,
      pid,
      descriptors,
      knownType: knownTypes.has(streamType),
    });
    cursor = descEnd;
  }
  return { pcrPid, programInfoDescriptors, streams };
}

export interface TableState {
  patGenerations: PatGeneration[];
  pmtGenerations: PmtGeneration[];
  events: TimelineEvent[];
}

export function buildTableState(
  sections: readonly PsiSection[],
  issues: readonly SectionIssue[],
  knownTypes: ReadonlySet<number>,
): TableState {
  const events: TimelineEvent[] = [];
  const patGenerations: PatGeneration[] = [];
  const pmtGenerations: PmtGeneration[] = [];
  const pmtByPid = new Map<number, number>(); // PMT PID -> programNumber（由现行 PAT 学习）

  // section 已按到达顺序产出；这里保持顺序，绝不再按 PID 排序。
  let patId = 0;
  let pmtId = 0;
  let lastProgramSet = new Set<number>();

  const closePrev = (gens: { endPacket: number | null }[], index: number, packetIndex: number): void => {
    if (index > 0 && gens[index - 1]!.endPacket === null) {
      gens[index - 1]!.endPacket = packetIndex - 1;
    }
  };

  for (const section of sections) {
    if (section.tableId === TABLE_ID_PAT && section.pid === 0) {
      if (!section.crcValid || !section.currentNextIndicator) {
        emitSectionAudit(events, section, issues);
        continue;
      }
      const entries = parsePat(section);
      const prev = patGenerations[patGenerations.length - 1];
      const rolledBack = prev ? versionForwardDistance(prev.version, section.version) > 16 : false;
      closePrev(patGenerations, patGenerations.length, section.startPacket);
      const gen: PatGeneration = {
        id: patId++,
        version: section.version,
        rolledBack,
        startPacket: section.startPacket,
        endPacket: null,
        entries,
        sourceSection: {
          startPacket: section.startPacket,
          endPacket: section.endPacket,
          carriedPackets: [...section.carriedPackets],
          sectionNumber: section.sectionNumber,
          lastSectionNumber: section.lastSectionNumber,
        },
      };
      patGenerations.push(gen);
      events.push({
        packetIndex: section.startPacket,
        pid: section.pid,
        kind: 'pat-generation',
        message: `PAT v${section.version} 生效（${entries.filter((e) => e.programNumber !== 0).length} 个节目）`,
        detail: { version: section.version, rolledBack, entries: entries.map((e) => ({ ...e })) },
      });
      if (rolledBack) {
        events.push({
          packetIndex: section.startPacket,
          pid: section.pid,
          kind: 'rollback',
          message: `PAT version 回滚：v${prev!.version} → v${section.version}`,
          detail: { from: prev!.version, to: section.version },
        });
      }
      for (const e of entries) if (e.programNumber !== 0) pmtByPid.set(e.pmtPid, e.programNumber);
      const nextSet = new Set(entries.filter((e) => e.programNumber !== 0).map((e) => e.programNumber));
      const added = [...nextSet].filter((p) => !lastProgramSet.has(p));
      const removed = [...lastProgramSet].filter((p) => !nextSet.has(p));
      for (const programNumber of added) {
        events.push({
          packetIndex: section.startPacket,
          pid: section.pid,
          kind: 'program-switch',
          message: `节目表加入 program ${programNumber}`,
          detail: { programNumber, change: 'added' },
        });
      }
      for (const programNumber of removed) {
        events.push({
          packetIndex: section.startPacket,
          pid: section.pid,
          kind: 'program-switch',
          message: `节目表移除 program ${programNumber}`,
          detail: { programNumber, change: 'removed' },
        });
      }
      lastProgramSet = nextSet;
      continue;
    }

    if (section.tableId === TABLE_ID_PMT) {
      const programNumber = pmtByPid.get(section.pid) ?? section.tableIdExtension;
      if (!section.crcValid || !section.currentNextIndicator) {
        emitSectionAudit(events, section, issues, programNumber);
        continue;
      }
      const body = parsePmt(section, knownTypes);
      const prior = [...pmtGenerations].reverse().find((g) => g.programNumber === programNumber);
      const rolledBack = prior ? versionForwardDistance(prior.version, section.version) > 16 : false;
      const sameProgramGens = pmtGenerations
        .map((g, i) => ({ g, i }))
        .filter((x) => x.g.programNumber === programNumber);
      if (sameProgramGens.length > 0) {
        const last = sameProgramGens[sameProgramGens.length - 1]!;
        if (pmtGenerations[last.i]!.endPacket === null) {
          pmtGenerations[last.i]!.endPacket = section.startPacket - 1;
        }
      }
      const gen: PmtGeneration = {
        id: pmtId++,
        programNumber,
        version: section.version,
        rolledBack,
        pcrPid: body.pcrPid,
        programInfoDescriptors: body.programInfoDescriptors,
        streams: body.streams,
        startPacket: section.startPacket,
        endPacket: null,
        sourceSection: {
          startPacket: section.startPacket,
          endPacket: section.endPacket,
          carriedPackets: [...section.carriedPackets],
        },
      };
      pmtGenerations.push(gen);
      events.push({
        packetIndex: section.startPacket,
        pid: section.pid,
        kind: 'pmt-generation',
        message: `PMT program ${programNumber} v${section.version} 生效（PCR_PID=0x${body.pcrPid
          .toString(16)
          .padStart(4, '0')}，${body.streams.length} 个 ES）`,
        detail: {
          programNumber,
          version: section.version,
          rolledBack,
          pcrPid: body.pcrPid,
          streamCount: body.streams.length,
        },
      });
      if (rolledBack) {
        events.push({
          packetIndex: section.startPacket,
          pid: section.pid,
          kind: 'rollback',
          message: `PMT program ${programNumber} version 回滚：v${prior!.version} → v${section.version}`,
          detail: { programNumber, from: prior!.version, to: section.version },
        });
      }
    }
  }

  return { patGenerations, pmtGenerations, events };
}

function emitSectionAudit(
  events: TimelineEvent[],
  section: PsiSection,
  issues: readonly SectionIssue[],
  programNumber?: number,
): void {
  const matching = issues.filter(
    (i) =>
      i.pid === section.pid &&
      i.tableIdExtension === section.tableIdExtension &&
      i.packetIndex === section.endPacket,
  );
  const reason = !section.crcValid
    ? matching[0]?.reason ?? 'CRC 校验失败'
    : section.currentNextIndicator
      ? 'section 被拒绝'
      : 'current_next=0（待生效，暂不应用）';
  events.push({
    packetIndex: section.endPacket,
    pid: section.pid,
    kind: 'psi-error',
    message: `${section.tableId === 0 ? 'PAT' : 'PMT'} section v${section.version} 未应用：${reason}`,
    detail: {
      tableId: section.tableId,
      version: section.version,
      currentNext: section.currentNextIndicator,
      crcValid: section.crcValid,
      programNumber,
    },
  });
}

/** 查询某个 packet 当刻生效的 PAT 代次。 */
export function patAt(pats: readonly PatGeneration[], packetIndex: number): PatGeneration | null {
  let current: PatGeneration | null = null;
  for (const g of pats) if (g.startPacket <= packetIndex) current = g;
  return current;
}

/** 查询某 program 在某 packet 当刻生效的 PMT 代次。 */
export function pmtAt(
  pmts: readonly PmtGeneration[],
  programNumber: number,
  packetIndex: number,
): PmtGeneration | null {
  let current: PmtGeneration | null = null;
  for (const g of pmts) {
    if (g.programNumber === programNumber && g.startPacket <= packetIndex) current = g;
  }
  return current;
}
