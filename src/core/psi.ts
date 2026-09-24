import { crcOk } from './crc32'
import type { PmtStream } from './types'

export interface AssembledSection {
  bytes: Uint8Array
  startIdx: number
  endIdx: number
}

export interface SectionError {
  idx: number
  reason: string
}

const MAX_SECTION = 3 + 1021

export class SectionAssembler {
  private buf: number[] = []
  private startIdx = -1
  private expected = -1

  reset(): void {
    this.buf = []
    this.startIdx = -1
    this.expected = -1
  }

  private totalLength(): number {
    if (this.buf.length < 3) return -1
    return 3 + (((this.buf[1] & 0x0f) << 8) | this.buf[2])
  }

  private append(chunk: Uint8Array, idx: number, out: AssembledSection[], errs: SectionError[]): void {
    let pos = 0
    while (pos < chunk.length) {
      if (this.buf.length === 0) {
        if (chunk[pos] === 0xff) return // stuffing
        this.startIdx = idx
      }
      this.buf.push(chunk[pos])
      pos++
      if (this.buf.length === 3) {
        this.expected = this.totalLength()
        if (this.expected > MAX_SECTION) {
          errs.push({ idx, reason: `section_length ${this.expected - 3} exceeds 1021` })
          this.reset()
          return
        }
      }
      if (this.expected > 0 && this.buf.length === this.expected) {
        out.push({ bytes: Uint8Array.from(this.buf), startIdx: this.startIdx, endIdx: idx })
        this.reset()
      }
    }
  }

  feed(
    payload: Uint8Array,
    pusi: boolean,
    idx: number,
  ): { sections: AssembledSection[]; errors: SectionError[] } {
    const sections: AssembledSection[] = []
    const errors: SectionError[] = []
    if (payload.length === 0) return { sections, errors }
    if (pusi) {
      const pointer = payload[0]
      if (pointer > payload.length - 1) {
        errors.push({ idx, reason: `pointer_field ${pointer} overruns payload` })
        this.reset()
        return { sections, errors }
      }
      if (pointer > 0) {
        if (this.buf.length === 0) {
          errors.push({ idx, reason: 'pointer_field continuation without open section' })
        } else {
          this.append(payload.subarray(1, 1 + pointer), idx, sections, errors)
        }
      }
      // bytes after the pointer start a new section; drop any dangling partial
      if (this.buf.length > 0) {
        errors.push({ idx, reason: 'truncated section dropped at PUSI boundary' })
        this.reset()
      }
      this.append(payload.subarray(1 + pointer), idx, sections, errors)
    } else {
      if (this.buf.length === 0) {
        errors.push({ idx, reason: 'continuation packet without open section' })
      } else {
        this.append(payload, idx, sections, errors)
      }
    }
    return { sections, errors }
  }
}

export interface PatBody {
  version: number
  currentNext: boolean
  programs: { program: number; pid: number }[]
}

export interface PmtBody {
  version: number
  currentNext: boolean
  program: number
  pcrPid: number
  programDescriptors: { tag: number; data: string }[]
  streams: PmtStream[]
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function parseDescriptors(b: Uint8Array, o: number, len: number): { tag: number; data: string }[] {
  const out: { tag: number; data: string }[] = []
  const end = o + len
  while (o + 2 <= end) {
    const tag = b[o]
    const l = b[o + 1]
    out.push({ tag, data: hex(b.subarray(o + 2, Math.min(o + 2 + l, end))) })
    o += 2 + l
  }
  return out
}

export function parsePAT(section: Uint8Array): PatBody {
  if (section[0] !== 0x00) throw new Error(`PAT table_id ${section[0]}`)
  if (!crcOk(section)) throw new Error('PAT CRC mismatch')
  const version = (section[5] >> 1) & 0x1f
  const currentNext = (section[5] & 1) === 1
  const programs: { program: number; pid: number }[] = []
  for (let o = 8; o + 4 <= section.length - 4; o += 4) {
    const program = (section[o] << 8) | section[o + 1]
    const pid = ((section[o + 2] & 0x1f) << 8) | section[o + 3]
    programs.push({ program, pid })
  }
  return { version, currentNext, programs }
}

export function parsePMT(section: Uint8Array): PmtBody {
  if (section[0] !== 0x02) throw new Error(`PMT table_id ${section[0]}`)
  if (!crcOk(section)) throw new Error('PMT CRC mismatch')
  const program = (section[3] << 8) | section[4]
  const version = (section[5] >> 1) & 0x1f
  const currentNext = (section[5] & 1) === 1
  const pcrPid = ((section[8] & 0x1f) << 8) | section[9]
  const progInfoLen = ((section[10] & 0x0f) << 8) | section[11]
  const programDescriptors = parseDescriptors(section, 12, progInfoLen)
  const streams: PmtStream[] = []
  let o = 12 + progInfoLen
  const end = section.length - 4
  while (o + 5 <= end) {
    const streamType = section[o]
    const pid = ((section[o + 1] & 0x1f) << 8) | section[o + 2]
    const esLen = ((section[o + 3] & 0x0f) << 8) | section[o + 4]
    streams.push({
      streamType,
      pid,
      descriptors: parseDescriptors(section, o + 5, esLen),
    })
    o += 5 + esLen
  }
  return { version, currentNext, program, pcrPid, programDescriptors, streams }
}
