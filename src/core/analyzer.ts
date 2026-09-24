import { detectPacketSize, iterPackets } from './packetize'
import { parsePacket } from './tsPacket'
import { SectionAssembler, parsePAT, parsePMT } from './psi'
import { crcOk } from './crc32'
import type {
  AnalysisResult,
  EventRow,
  PacketRow,
  PatGen,
  PcrSample,
  PidMapEntry,
  PmtGen,
  SectionRow,
  StateSnapshot,
} from './types'

const PCR_WRAP = 2 ** 33 * 300 // 27 MHz ticks per PCR epoch

interface CcState {
  lastCc: number
  seen: boolean
  resetAllowed: boolean
}

interface PcrState {
  prevRaw: number
  wraps: number
}

function patKey(g: { version: number; programs: { program: number; pid: number }[] }): string {
  return JSON.stringify([g.version, g.programs])
}

function pmtKey(g: { version: number; pcrPid: number; streams: { streamType: number; pid: number }[] }): string {
  return JSON.stringify([g.version, g.pcrPid, g.streams])
}

export function analyze(buf: Uint8Array): AnalysisResult {
  const packetSize = detectPacketSize(buf)
  const packets: PacketRow[] = []
  const sections: SectionRow[] = []
  const events: EventRow[] = []
  const patGenerations: PatGen[] = []
  const pmtGenerations: PmtGen[] = []
  const pcrSamples: PcrSample[] = []

  const ccStates = new Map<number, CcState>()
  const pcrStates = new Map<number, PcrState>()
  const assemblers = new Map<number, SectionAssembler>()
  const pmtPids = new Set<number>()
  const genCounters = new Map<number, number>()

  const assemblerFor = (pid: number): SectionAssembler => {
    let a = assemblers.get(pid)
    if (!a) {
      a = new SectionAssembler()
      assemblers.set(pid, a)
    }
    return a
  }

  const activePmtGen = (pid: number, idx: number): PmtGen | null => {
    let best: PmtGen | null = null
    for (const g of pmtGenerations) {
      if (g.pid === pid && g.startIdx <= idx && (!best || g.gen > best.gen)) best = g
    }
    return best
  }

  const attributeProgram = (
    pid: number,
    idx: number,
  ): { program: number | null; pmtGen: number | null } => {
    for (const g of pmtGenerations) {
      if (g.startIdx > idx) continue
      if (activePmtGen(g.pid, idx) !== g) continue
      if (g.pcrPid === pid || g.streams.some((s) => s.pid === pid)) {
        return { program: g.program, pmtGen: g.gen }
      }
    }
    return { program: null, pmtGen: null }
  }

  for (const { index, offset, bytes } of iterPackets(buf, packetSize)) {
    const pkt = parsePacket(index, offset, bytes)
    packets.push({
      idx: index,
      pid: pkt.pid,
      pusi: pkt.pusi,
      tei: pkt.tei,
      afc: pkt.afc,
      cc: pkt.cc,
      hasPayload: pkt.hasPayload,
      discontinuity: pkt.discontinuity,
      hasPcr: pkt.pcrRaw !== undefined,
      hasOpcr: pkt.opcrRaw !== undefined,
    })

    // --- continuity counter: only payload-bearing packets advance CC ---
    let cc = ccStates.get(pkt.pid)
    if (!cc) {
      cc = { lastCc: 0, seen: false, resetAllowed: false }
      ccStates.set(pkt.pid, cc)
    }
    if (pkt.hasPayload) {
      if (!cc.seen) {
        cc.seen = true
      } else if (cc.resetAllowed) {
        if (pkt.cc !== ((cc.lastCc + 1) & 0x0f) && pkt.cc !== cc.lastCc) {
          events.push({
            idx: index,
            pid: pkt.pid,
            kind: 'cc_reset',
            detail: { expected: (cc.lastCc + 1) & 0x0f, actual: pkt.cc },
          })
        }
        cc.resetAllowed = false
      } else if (pkt.cc === cc.lastCc) {
        events.push({ idx: index, pid: pkt.pid, kind: 'duplicate', detail: { cc: pkt.cc } })
      } else {
        const expected = (cc.lastCc + 1) & 0x0f
        if (pkt.cc !== expected) {
          events.push({
            idx: index,
            pid: pkt.pid,
            kind: 'gap',
            detail: { expected, actual: pkt.cc, lost: (pkt.cc - expected + 16) % 16 },
          })
        }
      }
      cc.lastCc = pkt.cc
    }
    if (pkt.discontinuity) {
      cc.resetAllowed = true
      events.push({ idx: index, pid: pkt.pid, kind: 'discontinuity', detail: { afc: pkt.afc } })
    }

    // --- PCR / OPCR unwrap (per PID, 33-bit base epoch) ---
    if (pkt.pcrRaw !== undefined) {
      let st = pcrStates.get(pkt.pid)
      if (!st) {
        st = { prevRaw: pkt.pcrRaw, wraps: 0 }
        pcrStates.set(pkt.pid, st)
      } else {
        if (pkt.pcrRaw - st.prevRaw < -PCR_WRAP / 2) st.wraps++
        st.prevRaw = pkt.pcrRaw
      }
      const attr = attributeProgram(pkt.pid, index)
      pcrSamples.push({
        idx: index,
        pid: pkt.pid,
        raw27: pkt.pcrRaw,
        unwrapped27: pkt.pcrRaw + st.wraps * PCR_WRAP,
        wraps: st.wraps,
        program: attr.program,
        pmtGen: attr.pmtGen,
      })
    }

    // --- PSI section reassembly on PAT / known PMT pids ---
    if (pkt.hasPayload && pkt.payload && pkt.payload.length > 0) {
      const isPsiPid = pkt.pid === 0x0000 || pmtPids.has(pkt.pid)
      if (isPsiPid) {
        const { sections: done, errors } = assemblerFor(pkt.pid).feed(pkt.payload, pkt.pusi, index)
        for (const e of errors) {
          events.push({ idx: e.idx, pid: pkt.pid, kind: 'section_error', detail: { reason: e.reason } })
        }
        for (const sec of done) {
          const tableId = sec.bytes[0]
          const row: SectionRow = {
            pid: pkt.pid,
            tableId,
            version: sec.bytes.length > 5 ? (sec.bytes[5] >> 1) & 0x1f : 0,
            currentNext: sec.bytes.length > 5 ? (sec.bytes[5] & 1) === 1 : false,
            sectionNumber: sec.bytes.length > 6 ? sec.bytes[6] : 0,
            startIdx: sec.startIdx,
            endIdx: sec.endIdx,
            crcOk: crcOk(sec.bytes),
          }
          if (!row.crcOk) {
            row.error = 'CRC mismatch'
            events.push({
              idx: sec.endIdx,
              pid: pkt.pid,
              kind: 'crc_error',
              detail: { tableId, startIdx: sec.startIdx },
            })
            sections.push(row)
            continue
          }
          try {
            if (tableId === 0x00 && pkt.pid === 0x0000) {
              const pat = parsePAT(sec.bytes)
              row.version = pat.version
              row.currentNext = pat.currentNext
              if (pat.currentNext) {
                const active = patGenerations[patGenerations.length - 1]
                if (!active || patKey(active) !== patKey(pat)) {
                  const gen: PatGen = {
                    gen: patGenerations.length,
                    startIdx: sec.endIdx,
                    version: pat.version,
                    programs: pat.programs,
                  }
                  patGenerations.push(gen)
                  events.push({
                    idx: sec.endIdx,
                    pid: 0,
                    kind: 'pat_gen',
                    detail: { gen: gen.gen, version: pat.version, programs: pat.programs },
                  })
                  for (const p of pat.programs) if (p.program !== 0) pmtPids.add(p.pid)
                }
              }
            } else if (tableId === 0x02) {
              const pmt = parsePMT(sec.bytes)
              row.version = pmt.version
              row.currentNext = pmt.currentNext
              if (pmt.currentNext) {
                const active = activePmtGen(pkt.pid, sec.endIdx)
                if (!active || pmtKey(active) !== pmtKey(pmt)) {
                  const gen: PmtGen = {
                    gen: genCounters.get(pkt.pid) ?? 0,
                    pid: pkt.pid,
                    program: pmt.program,
                    startIdx: sec.endIdx,
                    version: pmt.version,
                    pcrPid: pmt.pcrPid,
                    streams: pmt.streams,
                  }
                  genCounters.set(pkt.pid, gen.gen + 1)
                  pmtGenerations.push(gen)
                  events.push({
                    idx: sec.endIdx,
                    pid: pkt.pid,
                    kind: 'pmt_gen',
                    detail: { gen: gen.gen, program: pmt.program, version: pmt.version },
                  })
                }
              }
            }
          } catch (err) {
            row.error = err instanceof Error ? err.message : String(err)
            events.push({
              idx: sec.endIdx,
              pid: pkt.pid,
              kind: 'section_error',
              detail: { tableId, error: row.error },
            })
          }
          sections.push(row)
        }
      } else if (
        pkt.pusi &&
        pkt.payload.length >= 4 &&
        pkt.payload[0] === 0x00 &&
        pkt.payload[1] === 0x00 &&
        pkt.payload[2] === 0x01
      ) {
        const attr = attributeProgram(pkt.pid, index)
        events.push({
          idx: index,
          pid: pkt.pid,
          kind: 'pes_start',
          detail: { streamId: pkt.payload[3], program: attr.program, pmtGen: attr.pmtGen },
        })
      }
    }
  }

  return {
    packetSize,
    packetCount: packets.length,
    packets,
    sections,
    patGenerations,
    pmtGenerations,
    events,
    pcrSamples,
  }
}

export function stateAt(result: AnalysisResult, idx: number): StateSnapshot {
  const patGen = [...result.patGenerations].reverse().find((g) => g.startIdx <= idx) ?? null
  const pids = new Map<number, PidMapEntry>()
  pids.set(0x0000, { pid: 0x0000, role: 'PAT' })
  if (patGen) {
    for (const p of patGen.programs) {
      if (p.program === 0) {
        pids.set(p.pid, { pid: p.pid, role: 'NIT' })
        continue
      }
      pids.set(p.pid, { pid: p.pid, role: 'PMT', program: p.program })
      const pmt = [...result.pmtGenerations]
        .reverse()
        .find((g) => g.pid === p.pid && g.startIdx <= idx)
      if (pmt) {
        pids.get(p.pid)!.pmtGen = pmt.gen
        for (const s of pmt.streams) {
          const isPcr = s.pid === pmt.pcrPid
          pids.set(s.pid, {
            pid: s.pid,
            role: isPcr ? 'PCR+ES' : 'ES',
            program: pmt.program,
            streamType: s.streamType,
            pmtGen: pmt.gen,
          })
        }
        if (!pmt.streams.some((s) => s.pid === pmt.pcrPid)) {
          pids.set(pmt.pcrPid, { pid: pmt.pcrPid, role: 'PCR', program: pmt.program, pmtGen: pmt.gen })
        }
      }
    }
  }
  return {
    idx,
    patGen: patGen ? patGen.gen : null,
    pids: [...pids.values()].sort((a, b) => a.pid - b.pid),
  }
}
