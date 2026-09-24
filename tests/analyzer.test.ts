import { describe, it, expect } from 'vitest'
import { analyze, stateAt } from '../src/core/analyzer'
import { detectPacketSize, iterPackets } from '../src/core/packetize'
import { buildSampleStream, PID } from '../src/fixtures/sampleStream'

const buf = buildSampleStream()
const result = analyze(buf)

function wrap(buf: Uint8Array, size: 192 | 204): Uint8Array {
  const n = buf.length / 188
  const out = new Uint8Array(n * size)
  for (let i = 0; i < n; i++) {
    const dst = i * size
    const src = i * 188
    if (size === 192) {
      out.set([0x00, 0x00, 0x00, 0x00], dst)
      out.set(buf.subarray(src, src + 188), dst + 4)
    } else {
      out.set(buf.subarray(src, src + 188), dst)
      out.set(new Uint8Array(16).fill(0xaa), dst + 188)
    }
  }
  return out
}

describe('packetize', () => {
  it('detects 188-byte packets', () => {
    expect(detectPacketSize(buf)).toBe(188)
    expect([...iterPackets(buf, 188)].length).toBe(23)
  })
  it('detects 192-byte packets with 4-byte prefix', () => {
    const w = wrap(buf, 192)
    expect(detectPacketSize(w)).toBe(192)
    const pkts = [...iterPackets(w, 192)]
    expect(pkts.length).toBe(23)
    expect(pkts[0].bytes[0]).toBe(0x47)
  })
  it('detects 204-byte packets with 16-byte suffix', () => {
    const w = wrap(buf, 204)
    expect(detectPacketSize(w)).toBe(204)
    expect([...iterPackets(w, 204)].length).toBe(23)
  })
  it('rejects non-TS buffers', () => {
    expect(() => detectPacketSize(new Uint8Array(500))).toThrow()
  })
})

describe('PAT/PMT generations', () => {
  it('tracks PAT generations across the program switch', () => {
    expect(result.patGenerations.map((g) => [g.gen, g.startIdx, g.version])).toEqual([
      [0, 0, 0],
      [1, 18, 1],
    ])
    expect(result.patGenerations[0].programs).toEqual([{ program: 1, pid: PID.PMT1 }])
    expect(result.patGenerations[1].programs).toEqual([{ program: 1, pid: PID.PMT2 }])
  })
  it('tracks PMT generations incl. version rollback', () => {
    const gens = result.pmtGenerations.filter((g) => g.pid === PID.PMT1)
    expect(gens.map((g) => [g.gen, g.startIdx, g.version])).toEqual([
      [0, 1, 0],
      [1, 14, 1],
      [2, 16, 0], // rollback to v0 still opens a new generation
    ])
    const gens2 = result.pmtGenerations.filter((g) => g.pid === PID.PMT2)
    expect(gens2.map((g) => [g.gen, g.startIdx, g.version])).toEqual([[0, 19, 0]])
  })
  it('preserves unknown stream types and descriptors verbatim', () => {
    const gen0 = result.pmtGenerations.find((g) => g.pid === PID.PMT1 && g.gen === 0)!
    const unknown = gen0.streams.find((s) => s.pid === PID.UNKNOWN)!
    expect(unknown.streamType).toBe(0x81)
    expect(unknown.descriptors).toEqual([{ tag: 0x52, data: '01' }])
  })
})

describe('section reassembly', () => {
  it('reassembles a section spanning three packets', () => {
    const sec = result.sections.find((s) => s.pid === PID.PMT1 && s.version === 1 && s.crcOk)!
    expect(sec.startIdx).toBe(12)
    expect(sec.endIdx).toBe(14)
  })
  it('rejects the corrupted section without polluting the previous generation', () => {
    const bad = result.sections.find((s) => s.endIdx === 15)!
    expect(bad.crcOk).toBe(false)
    expect(result.events.some((e) => e.kind === 'crc_error' && e.idx === 15)).toBe(true)
    // mapping between packet 14 and 15 still comes from PMT gen 1 (v1)
    const st = stateAt(result, 15)
    const video = st.pids.find((p) => p.pid === PID.VIDEO)!
    expect(video.pmtGen).toBe(1)
    // the poisoned v2 stream 0x0199 must never appear
    expect(st.pids.some((p) => p.pid === 0x0199)).toBe(false)
    // and no generation was created from the bad section
    expect(result.pmtGenerations.filter((g) => g.pid === PID.PMT1).length).toBe(3)
  })
})

describe('continuity counter', () => {
  it('counts CC only on payload-bearing packets; adaptation-only packets are inert', () => {
    expect(result.events.filter((e) => e.idx === 2)).toEqual([])
    expect(result.events.filter((e) => e.idx === 8 && e.kind !== 'discontinuity')).toEqual([])
  })
  it('distinguishes legal duplicates from real loss', () => {
    const dup = result.events.find((e) => e.kind === 'duplicate')!
    expect(dup.idx).toBe(6)
    expect(dup.pid).toBe(PID.VIDEO)
    const gaps = result.events.filter((e) => e.kind === 'gap')
    expect(gaps.length).toBe(1)
    expect(gaps[0].idx).toBe(7)
    expect(gaps[0].pid).toBe(PID.VIDEO)
    expect(gaps[0].detail).toMatchObject({ expected: 2, actual: 3, lost: 1 })
  })
  it('scopes discontinuity to its own PID only', () => {
    const reset = result.events.find((e) => e.kind === 'cc_reset')!
    expect(reset.idx).toBe(9)
    expect(reset.pid).toBe(PID.AUDIO)
    // video CC at packet 10 follows packet 7 normally: no gap/reset events on VIDEO after 7
    expect(
      result.events.some(
        (e) => e.pid === PID.VIDEO && (e.kind === 'gap' || e.kind === 'cc_reset') && e.idx > 7,
      ),
    ).toBe(false)
    // audio itself has no gap event (the reset was legal)
    expect(result.events.some((e) => e.pid === PID.AUDIO && e.kind === 'gap')).toBe(false)
  })
})

describe('PCR unwrap and attribution', () => {
  it('unwraps the 33-bit PCR wrap monotonically', () => {
    const videoPcr = result.pcrSamples.filter((s) => s.pid === PID.VIDEO)
    expect(videoPcr.map((s) => s.idx)).toEqual([2, 11, 17])
    for (let i = 1; i < videoPcr.length; i++) {
      expect(videoPcr[i].unwrapped27).toBeGreaterThan(videoPcr[i - 1].unwrapped27)
    }
    expect(videoPcr[2].wraps).toBe(1)
    // raw wrapped back near zero while unwrapped keeps climbing
    expect(videoPcr[2].raw27).toBeLessThan(videoPcr[1].raw27)
    const deltaSec = (videoPcr[2].unwrapped27 - videoPcr[1].unwrapped27) / 27e6
    expect(deltaSec).toBeCloseTo(10, 3)
  })
  it('attributes PCR to the program active at that packet', () => {
    const at2 = result.pcrSamples.find((s) => s.idx === 2)!
    expect(at2.program).toBe(1)
    expect(at2.pmtGen).toBe(0)
    const at20 = result.pcrSamples.find((s) => s.idx === 20)!
    expect(at20.program).toBe(1)
    expect(at20.pid).toBe(PID.VIDEO2)
  })
  it('attributes PES starts to the active program generation', () => {
    const pes = result.events.filter((e) => e.kind === 'pes_start')
    expect(pes.length).toBeGreaterThan(0)
    expect(pes.find((e) => e.idx === 3)!.detail).toMatchObject({ program: 1, pmtGen: 0 })
  })
})

describe('state at packet', () => {
  it('maps PIDs at packet 10 (PMT1 v0 era)', () => {
    const st = stateAt(result, 10)
    expect(st.patGen).toBe(0)
    const byPid = new Map(st.pids.map((p) => [p.pid, p]))
    expect(byPid.get(0)!.role).toBe('PAT')
    expect(byPid.get(PID.PMT1)!.role).toBe('PMT')
    expect(byPid.get(PID.VIDEO)!.role).toBe('PCR+ES')
    expect(byPid.get(PID.VIDEO)!.streamType).toBe(0x1b)
    expect(byPid.get(PID.AUDIO)!.streamType).toBe(0x0f)
    expect(byPid.get(PID.UNKNOWN)!.streamType).toBe(0x81)
  })
  it('maps PIDs at packet 20 (after program switch)', () => {
    const st = stateAt(result, 20)
    expect(st.patGen).toBe(1)
    const byPid = new Map(st.pids.map((p) => [p.pid, p]))
    expect(byPid.get(PID.PMT2)!.role).toBe('PMT')
    expect(byPid.get(PID.VIDEO2)!.role).toBe('PCR+ES')
    expect(byPid.has(PID.VIDEO)).toBe(false)
  })
  it('reflects the PMT v1 era between packets 14 and 15', () => {
    const st = stateAt(result, 14)
    expect(st.pids.some((p) => p.pid === PID.AUDIO2)).toBe(true)
  })
})
