/** MPEG-TS 审阅台核心数据模型。
 *
 * 所有结构只承载“分析结果”，不回持原始字节，便于序列化进 SQLite / 下发浏览器。
 */

/** 传输流封装形式。 */
export type FrameSize = 188 | 192 | 204;

/** 同步后、去封装的单个 188 字节 packet 的解析视图。 */
export interface TsPacket {
  /** 到达顺序（文件 / 缓冲区内的物理序号，从 0 起，保留乱序原貌）。 */
  arrivalIndex: number;
  /** 解析所用封装大小。 */
  frameSize: FrameSize;
  /** 封装前导（192 字节 ATSC 时为 4 字节，其它为 0）。 */
  prefixBytes: Uint8Array;
  /** 完整帧（含前导 / RS 尾）。 */
  frame: Uint8Array;
  /** 188 字节 MPEG-TS 包体。 */
  ts: Uint8Array;
  /** transport_error_indicator（解析器只记录，不丢弃）。 */
  tei: boolean;
  payloadUnitStartIndicator: boolean;
  priority: boolean;
  pid: number;
  /** transport_scrambling_control。 */
  scrambling: number;
  adaptationFieldControl: number;
  continuityCounter: number;
  /** 去 adaptation 后的 payload 区间（相对 ts 包）；无 payload 时为 null。 */
  payload: { offset: number; length: number } | null;
  adaptation: AdaptationField | null;
}

export interface PcrValue {
  /** 42 位原始 PCR（base*300+ext）。 */
  raw: bigint;
  base: bigint;
  extension: number;
}

export interface AdaptationField {
  length: number;
  /** 全 0 时为空 adaptation（length=0）以外的有效标志。 */
  discontinuityIndicator: boolean;
  randomAccessIndicator: boolean;
  elementaryStreamPriorityIndicator: boolean;
  pcrFlag: boolean;
  opcrFlag: boolean;
  splicingPointFlag: boolean;
  transportPrivateDataFlag: boolean;
  adaptationFieldExtensionFlag: boolean;
  pcr: PcrValue | null;
  opcr: PcrValue | null;
  spliceCountdown: number | null;
  privateDataBytes: number | null;
  stuffingBytes: number;
}

/** 重组完成的 PSI section（不含 pointer_field，已校验 CRC）。 */
export interface PsiSection {
  pid: number;
  /** section 起始 packet 的 arrivalIndex（PUSI=1 的那个包）。 */
  startPacket: number;
  /** section 最后一个字节所在 packet 的 arrivalIndex。 */
  endPacket: number;
  /** 起始包内 pointer_field 后跳过的字节数。 */
  pointerField: number;
  tableId: number;
  sectionSyntaxIndicator: boolean;
  /** section_length 字段原值。 */
  sectionLength: number;
  /** section 总字节数 = 3 + sectionLength。 */
  totalLength: number;
  tableIdExtension: number;
  version: number;
  currentNextIndicator: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  /** CRC-32/MPEG-2 校验通过。 */
  crcValid: boolean;
  crcExpected: number;
  crcActual: number;
  /** section 原始字节（header 起，含 CRC）。 */
  data: Uint8Array;
  /** 承载该 section 的每个 packet arrivalIndex。 */
  carriedPackets: number[];
}

export interface ElementaryStream {
  streamType: number;
  pid: number;
  descriptors: Descriptor[];
  /** stream_type 是否在本审阅台已知范围（未知值仍保留原值）。 */
  knownType: boolean;
}

export interface Descriptor {
  tag: number;
  data: Uint8Array;
}

export interface PatEntry {
  programNumber: number;
  /** program 0 时为 network PID，否则为 PMT PID。 */
  pmtPid: number;
}

/** PAT 代次（table_id=0x00, current_next=1 且 CRC 正确时生成）。 */
export interface PatGeneration {
  id: number;
  version: number;
  /** 相对上一代 version 是否回滚（含跳变方向判断，按 mod 32 距离）。 */
  rolledBack: boolean;
  startPacket: number;
  endPacket: number | null;
  entries: PatEntry[];
  /** 触发该代次的 section。 */
  sourceSection: {
    startPacket: number;
    endPacket: number;
    carriedPackets: number[];
    sectionNumber: number;
    lastSectionNumber: number;
  };
}

/** PMT 代次，按 programNumber 分别维护。 */
export interface PmtGeneration {
  id: number;
  programNumber: number;
  version: number;
  rolledBack: boolean;
  pcrPid: number;
  programInfoDescriptors: Descriptor[];
  streams: ElementaryStream[];
  startPacket: number;
  endPacket: number | null;
  sourceSection: {
    startPacket: number;
    endPacket: number;
    carriedPackets: number[];
  };
}

/** 错误 / 待生效 section 审计记录（不参与映射）。 */
export interface SectionIssue {
  packetIndex: number;
  pid: number;
  tableId: number;
  tableIdExtension: number;
  version: number | null;
  currentNext: boolean;
  crcValid: boolean;
  /** pointer 越界、长度越界、pointer_field 非 0xFF 等。 */
  reason: string;
}

export type EventKind =
  | 'psi'
  | 'psi-error'
  | 'pat-generation'
  | 'pmt-generation'
  | 'pcr'
  | 'opcr'
  | 'discontinuity'
  | 'pes'
  | 'cc-gap'
  | 'cc-reorder'
  | 'cc-duplicate'
  | 'adaptation-only'
  | 'tei'
  | 'rollback'
  | 'program-switch';

export interface TimelineEvent {
  packetIndex: number;
  pid: number;
  kind: EventKind;
  message: string;
  /** 结构化细节（JSON 持久化）。 */
  detail: Record<string, unknown>;
}

export interface PesInfo {
  packetIndex: number;
  pid: number;
  streamId: number;
  length: number;
  pts: number | null;
  dts: number | null;
  /** PES header 之后首个字节的偏移（相对 ts）。 */
  dataOffset: number;
  dataLength: number;
  scrambled: boolean;
}

/** 某 packet 当刻 PID 映射视图。 */
export interface MappingSnapshot {
  packetIndex: number;
  /** programNumber -> 生效 PMT 代次。 */
  programs: Array<{
    programNumber: number;
    patVersion: number;
    pmtVersion: number;
    pcrPid: number;
    streams: ElementaryStream[];
  }>;
  /** PID -> 归属描述；未挂到任何节目的基础流会显式列出为 null。 */
  pidOwnership: Record<
    string,
    { programNumber: number; role: 'pmt' | 'elementary' | 'pcr'; streamType: number | null } | null
  >;
}

export interface AnalysisResult {
  frameSize: FrameSize;
  packetCount: number;
  packets: TsPacket[];
  sections: PsiSection[];
  patGenerations: PatGeneration[];
  pmtGenerations: PmtGeneration[];
  issues: SectionIssue[];
  events: TimelineEvent[];
  pes: PesInfo[];
  /** 每个 PID 的去重时间线索引（事件就是按 arrival 顺序追加的，不按 PID 重排）。 */
  pids: number[];
  /** 输入总字节数、同步丢弃前导字节数。 */
  inputBytes: number;
  skippedLeader: number;
}
