export interface TsPacket {
  index: number
  offset: number
  pid: number
  tei: boolean
  pusi: boolean
  scrambling: number
  afc: number
  cc: number
  hasPayload: boolean
  discontinuity: boolean
  pcrRaw?: number
  opcrRaw?: number
  payload?: Uint8Array
}

export interface SectionRow {
  pid: number
  tableId: number
  version: number
  currentNext: boolean
  sectionNumber: number
  startIdx: number
  endIdx: number
  crcOk: boolean
  error?: string
}

export interface PatGen {
  gen: number
  startIdx: number
  version: number
  programs: { program: number; pid: number }[]
}

export interface PmtStream {
  streamType: number
  pid: number
  descriptors: { tag: number; data: string }[]
}

export interface PmtGen {
  gen: number
  pid: number
  program: number
  startIdx: number
  version: number
  pcrPid: number
  streams: PmtStream[]
}

export type EventKind =
  | 'duplicate'
  | 'gap'
  | 'discontinuity'
  | 'cc_reset'
  | 'crc_error'
  | 'section_error'
  | 'pes_start'
  | 'pat_gen'
  | 'pmt_gen'

export interface EventRow {
  idx: number
  pid: number
  kind: EventKind
  detail: Record<string, unknown>
}

export interface PcrSample {
  idx: number
  pid: number
  raw27: number
  unwrapped27: number
  wraps: number
  program: number | null
  pmtGen: number | null
}

export interface PacketRow {
  idx: number
  pid: number
  pusi: boolean
  tei: boolean
  afc: number
  cc: number
  hasPayload: boolean
  discontinuity: boolean
  hasPcr: boolean
  hasOpcr: boolean
}

export interface AnalysisResult {
  packetSize: number
  packetCount: number
  packets: PacketRow[]
  sections: SectionRow[]
  patGenerations: PatGen[]
  pmtGenerations: PmtGen[]
  events: EventRow[]
  pcrSamples: PcrSample[]
}

export interface PidMapEntry {
  pid: number
  role: string
  program?: number
  streamType?: number
  pmtGen?: number
}

export interface StateSnapshot {
  idx: number
  patGen: number | null
  pids: PidMapEntry[]
}
