/** PSI section 重组：pointer_field、跨包拼接、section_length 与 CRC-32 校验。
 *
 * 严格保留到达顺序：重组器只按 arrivalIndex 处理，绝不按 PID 排序。
 */

import { crc32Mpeg2 } from './crc.js';
import type { PsiSection, SectionIssue, TsPacket } from './types.js';

interface Chunk {
  data: Uint8Array;
  packetIndex: number;
}

const SECTION_HEADER_LEN = 3;
const MIN_SECTION_LENGTH = 9; // 5 字节长格式头 + 4 字节 CRC
const MAX_SECTION_TOTAL = 1024; // 3 + 1021

class SectionBuilder {
  chunks: Chunk[] = [];
  totalLength = 0;
  declaredTotal: number | null = null;
  startPacket = -1;
  pointerField = 0;
  error: string | null = null;
  done = false;
  lastTableId: number | null = null;

  safeAt(index: number): number {
    let remain = index;
    for (const chunk of this.chunks) {
      if (remain < chunk.data.length) return chunk.data[remain]!;
      remain -= chunk.data.length;
    }
    return -1;
  }

  begin(startPacket: number, pointerField: number): void {
    this.chunks = [];
    this.totalLength = 0;
    this.declaredTotal = null;
    this.startPacket = startPacket;
    this.pointerField = pointerField;
    this.error = null;
    this.done = false;
    this.lastTableId = null;
  }

  feed(data: Uint8Array, packetIndex: number): boolean {
    if (this.done) return true;
    if (packetIndex === 0) console.error('F0len', data.length, 'head', [...data.slice(0,4)].map(x=>x.toString(16)).join(','));
    this.chunks.push({ data, packetIndex });
    this.totalLength += data.length;
    if (this.declaredTotal === null && this.totalLength >= SECTION_HEADER_LEN) {
      const b0 = this.at(0);
      const b1 = this.at(1);
      const b2 = this.at(2);
      const ssi = (b1 & 0x40) === 0x40;
      const sectionLength = ((b1 & 0x0f) << 8) | b2;
      if (!ssi) {
        this.error = `table_id=0x${b0.toString(16)} section_syntax_indicator=0，private section 不按 PSI 处理`;
        this.done = true;
        return true;
      }
      if (sectionLength < MIN_SECTION_LENGTH) {
        this.error = `section_length=${sectionLength} 小于最小值 ${MIN_SECTION_LENGTH}`;
        this.done = true;
        return true;
      }
      this.declaredTotal = SECTION_HEADER_LEN + sectionLength;
      if (this.declaredTotal > MAX_SECTION_TOTAL) {
        this.error = `section_length=${sectionLength} 超出 1021 上限`;
        this.done = true;
        return true;
      }
    }
    if (this.declaredTotal !== null && this.totalLength >= this.declaredTotal) {
      this.done = true;
      return true;
    }
    return false;
  }

  private at(index: number): number {
    let remain = index;
    for (const chunk of this.chunks) {
      if (remain < chunk.data.length) return chunk.data[remain]!;
      remain -= chunk.data.length;
    }
    throw new Error('section builder 越界');
  }

  finish(): { section: PsiSection | null; error: string | null } {
    if (!this.done) return { section: null, error: null };
    if (this.error) return { section: null, error: this.error };
    const total = this.declaredTotal!;
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const chunk of this.chunks) {
      const n = Math.min(chunk.data.length, total - off);
      bytes.set(chunk.data.subarray(0, n), off);
      off += n;
      if (off >= total) break;
    }
    const tableId = bytes[0]!;
    const sectionSyntaxIndicator = (bytes[1]! & 0x40) === 0x40;
    const sectionLength = ((bytes[1]! & 0x0f) << 8) | bytes[2]!;
    const tableIdExtension = (bytes[3]! << 8) | bytes[4]!;
    const version = (bytes[5]! >> 1) & 0x1f;
    const currentNextIndicator = (bytes[5]! & 0x01) === 1;
    const sectionNumber = bytes[6]!;
    const lastSectionNumber = bytes[7]!;
    // CRC 覆盖 table_id 之后起、section_length 声明的全部字节。
    const crcActual = crc32Mpeg2(bytes, 1, total);
    const crcExpected =
      (bytes[total - 4]! << 24) | (bytes[total - 3]! << 16) | (bytes[total - 2]! << 8) | bytes[total - 1]!;
    const carriedPackets = this.chunks.map((c) => c.packetIndex);
    const section: PsiSection = {
      pid: -1,
      startPacket: this.startPacket,
      endPacket: carriedPackets[carriedPackets.length - 1]!,
      pointerField: this.pointerField,
      tableId,
      sectionSyntaxIndicator,
      sectionLength,
      totalLength: total,
      tableIdExtension,
      version,
      currentNextIndicator,
      sectionNumber,
      lastSectionNumber,
      crcValid: crcActual === 0,
      crcExpected: crcExpected >>> 0,
      crcActual: crcActual >>> 0,
      data: bytes,
      carriedPackets,
    };
    return { section, error: null };
  }
}

export interface ReassemblyOutput {
  sections: PsiSection[];
  issues: SectionIssue[];
}

/** 对全部 packet（到达顺序）执行 PSI 重组。 */
export function reassembleSections(packets: readonly TsPacket[]): ReassemblyOutput {
  const sections: PsiSection[] = [];
  const issues: SectionIssue[] = [];
  const builders = new Map<number, SectionBuilder>();

  const pushIssue = (
    packet: TsPacket,
    builder: SectionBuilder | null,
    reason: string,
    crcValid = true,
  ): void => {
    const enough = (n: number): boolean => builder !== null && builder.totalLength >= n;
    issues.push({
      packetIndex: packet.arrivalIndex,
      pid: packet.pid,
      tableId: enough(1) ? builder!.safeAt(0) : -1,
      tableIdExtension: enough(5) ? (builder!.safeAt(3) << 8) | builder!.safeAt(4) : -1,
      version: enough(6) ? (builder!.safeAt(5) >> 1) & 0x1f : null,
      currentNext: enough(6) ? (builder!.safeAt(5) & 1) === 1 : false,
      crcValid,
      reason,
    });
  };

  for (const packet of packets) {
    if (!packet.payload) continue;
    let builder = builders.get(packet.pid);
    if (!builder) {
      builder = new SectionBuilder();
      builders.set(packet.pid, builder);
    }

    let offset = packet.payload.offset;
    if (packet.payloadUnitStartIndicator) {
      const pointer = packet.ts[packet.payload.offset]!;
      // payload 布局：[pointer_field(1)][pointer 字节 filler][section...][0xFF stuffing]
      const firstStart = packet.payload.offset + 1 + pointer;
      const payloadEnd = packet.payload.offset + packet.payload.length;
      if (firstStart > payloadEnd) {
        pushIssue(packet, builder, `pointer_field=${pointer} 越过 payload 边界`);
        continue;
      }
      if (!builder.done && builder.totalLength > 0) {
        pushIssue(
          packet,
          builder,
          `PUSI 到达但上一 section 未完成（已收集 ${builder.totalLength} 字节），丢弃残段`,
        );
      }
      builder.begin(packet.arrivalIndex, pointer);
      if (firstStart < payloadEnd) {
        consume(builder, packet.ts.subarray(firstStart, payloadEnd), packet, sections, issues);
      }
    } else {
      if (builder.totalLength === 0 || builder.done) {
        // 没有在收的 section：中间包先于起始包到达（乱序）或属于非 PSI 数据。
        if (packet.pid <= 0x001f || builder.lastTableId === 0x00 || builder.lastTableId === 0x02) {
          pushIssue(packet, builder, 'payload 中间包先于 section 起始包到达（乱序/丢起始包）');
        }
        continue;
      }
      consume(builder, packet.ts.subarray(offset, offset + packet.payload.length), packet, sections, issues);
    }
  }

  for (const [pid, builder] of builders) {
    if (!builder.done && builder.totalLength > 0) {
      issues.push({
        packetIndex: builder.startPacket,
        pid,
        tableId: builder.safeAt(0),
        tableIdExtension: builder.totalLength >= 5 ? (builder.safeAt(3) << 8) | builder.safeAt(4) : -1,
        version: builder.totalLength >= 6 ? (builder.safeAt(5) >> 1) & 0x1f : null,
        currentNext: builder.totalLength >= 6 ? (builder.safeAt(5) & 1) === 1 : false,
        crcValid: false,
        reason: `流结束时 section 仍缺 ${builder.declaredTotal !== null ? builder.declaredTotal - builder.totalLength : 'header'} 字节`,
      });
    }
  }

  return { sections, issues };
}

function consume(
  builder: SectionBuilder,
  data: Uint8Array,
  packet: TsPacket,
  sections: PsiSection[],
  issues: SectionIssue[],
): void {
  let cursor = 0;
  let guard = 0;
  while (cursor < data.length && guard++ < 8) {
    const before = builder.totalLength;
    const finished = builder.feed(data.subarray(cursor), packet.arrivalIndex);
    const consumed = builder.totalLength - before;
    cursor += consumed;
    if (!finished) return;
    if (builder.error) {
      pushIssueLocal(builder, packet, issues, builder.error);
      resetBuilder(builder);
      return;
    }
    const { section } = builder.finish();
    if (section) {
      section.pid = packet.pid;
      sections.push(section);
      if (!section.crcValid) {
        issues.push({
          packetIndex: section.endPacket,
          pid: section.pid,
          tableId: section.tableId,
          tableIdExtension: section.tableIdExtension,
          version: section.version,
          currentNext: section.currentNextIndicator,
          crcValid: false,
          reason: `CRC-32 校验失败：期望 0x${section.crcExpected.toString(16).padStart(8, '0')}，实得 0x${section.crcActual
            .toString(16)
            .padStart(8, '0')}`,
        });
      }
    }
    resetBuilder(builder);
    // 余下若只有 0xFF stuffing 则结束（PSI 合法填充）。
    if (cursor < data.length && data.subarray(cursor).every((b) => b === 0xff)) return;
    if (cursor < data.length) {
      builder.startPacket = packet.arrivalIndex;
      builder.pointerField = 0;
    }
  }
}

function resetBuilder(builder: SectionBuilder): void {
  builder.done = false;
  builder.totalLength = 0;
  builder.chunks = [];
  builder.declaredTotal = null;
  builder.error = null;
  builder.lastTableId = null;
}

function pushIssueLocal(
  builder: SectionBuilder,
  packet: TsPacket,
  issues: SectionIssue[],
  reason: string,
): void {
  issues.push({
    packetIndex: packet.arrivalIndex,
    pid: packet.pid,
    tableId: builder.totalLength >= 1 ? builder.safeAt(0) : -1,
    tableIdExtension: builder.totalLength >= 5 ? (builder.safeAt(3) << 8) | builder.safeAt(4) : -1,
    version: builder.totalLength >= 6 ? (builder.safeAt(5) >> 1) & 0x1f : null,
    currentNext: builder.totalLength >= 6 ? (builder.safeAt(5) & 1) === 1 : false,
    crcValid: false,
    reason,
  });
}
