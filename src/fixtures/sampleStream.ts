import { crc32mpeg } from '../core/crc32'

// PID plan for the built-in sample stream.
export const PID = {
  PAT: 0x0000,
  PMT1: 0x0100,
  VIDEO: 0x0101, // also PCR pid before the program switch
  AUDIO: 0x0102,
  UNKNOWN: 0x0103, // stream_type 0x81 with a private descriptor
  AUDIO2: 0x0104, // added by PMT v1
  PMT2: 0x0200,
  VIDEO2: 0x0201, // PCR pid after the program switch
} as const

interface PacketOpts {
  pid: number
  cc: number
  pusi?: boolean
  payload?: Uint8Array
  adaptation?: { discontinuity?: boolean; pcr27?: number; opcr27?: number }
}

function buildPacket(o: PacketOpts): Uint8Array {
  const pkt = new Uint8Array(188).fill(0xff)
  pkt[0] = 0x47
  pkt[1] = (o.pusi ? 0x40 : 0) | ((o.pid >> 8) & 0x1f)
  pkt[2] = o.pid & 0xff
  const hasAd = o.adaptation !== undefined
  const hasPl = o.payload !== undefined
  const afc = hasAd && hasPl ? 3 : hasAd ? 2 : 1
  pkt[3] = (afc << 4) | (o.cc & 0x0f)
  let pos = 4
  if (hasAd) {
    const ad = o.adaptation!
    const dataLen = (ad.pcr27 !== undefined ? 6 : 0) + (ad.opcr27 !== undefined ? 6 : 0)
    const payloadLen = hasPl ? o.payload!.length : 0
    const afl = 188 - 4 - 1 - payloadLen // absorbs all slack as stuffing
    if (afl < 1 + dataLen) throw new Error('adaptation field too small')
    pkt[pos] = afl
    let flags = 0
    if (ad.discontinuity) flags |= 0x80
    if (ad.pcr27 !== undefined) flags |= 0x10
    if (ad.opcr27 !== undefined) flags |= 0x08
    pkt[pos + 1] = flags
    let p = pos + 2
    const writePcr = (v27: number, at: number) => {
      const base = Math.floor(v27 / 300)
      const ext = v27 % 300
      let val = (BigInt(base) << 15n) | (0x3fn << 9n) | BigInt(ext)
      for (let i = 5; i >= 0; i--) {
        pkt[at + i] = Number(val & 0xffn)
        val >>= 8n
      }
    }
    if (ad.pcr27 !== undefined) {
      writePcr(ad.pcr27, p)
      p += 6
    }
    if (ad.opcr27 !== undefined) {
      writePcr(ad.opcr27, p)
      p += 6
    }
    pos += 1 + afl
  }
  if (hasPl) {
    pkt.set(o.payload!, pos)
  }
  return pkt
}

function section(tableId: number, body: number[]): Uint8Array {
  const len = body.length + 4
  const out = new Uint8Array(3 + len)
  out[0] = tableId
  out[1] = 0xb0 | ((len >> 8) & 0x0f)
  out[2] = len & 0xff
  out.set(body, 3)
  const crc = crc32mpeg(out.subarray(0, out.length - 4))
  const n = out.length
  out[n - 4] = (crc >>> 24) & 0xff
  out[n - 3] = (crc >>> 16) & 0xff
  out[n - 2] = (crc >>> 8) & 0xff
  out[n - 1] = crc & 0xff
  return out
}

function patBody(version: number, programs: [number, number][]): number[] {
  const body = [0x00, 0x01, 0xc0 | ((version & 0x1f) << 1) | 1, 0x00, 0x00]
  for (const [program, pid] of programs) {
    body.push((program >> 8) & 0xff, program & 0xff, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff)
  }
  return body
}

interface StreamSpec {
  type: number
  pid: number
  desc?: number[]
}

function pmtBody(
  version: number,
  program: number,
  pcrPid: number,
  streams: StreamSpec[],
  programDesc: number[] = [],
): number[] {
  const body = [
    (program >> 8) & 0xff,
    program & 0xff,
    0xc0 | ((version & 0x1f) << 1) | 1,
    0x00,
    0x00,
    0xe0 | ((pcrPid >> 8) & 0x1f),
    pcrPid & 0xff,
    0xf0 | ((programDesc.length >> 8) & 0x0f),
    programDesc.length & 0xff,
    ...programDesc,
  ]
  for (const s of streams) {
    const d = s.desc ?? []
    body.push(s.type & 0xff, 0xe0 | ((s.pid >> 8) & 0x1f), s.pid & 0xff, 0xf0 | ((d.length >> 8) & 0x0f), d.length & 0xff, ...d)
  }
  return body
}

// Split a section into TS packets. First packet carries pointer_field=0,
// last packet is padded with 0xFF stuffing inside the payload.
function sectionPackets(pid: number, sec: Uint8Array, ccStart: number): Uint8Array[] {
  const out: Uint8Array[] = []
  let sent = 0
  let cc = ccStart
  let first = true
  while (sent < sec.length) {
    const cap = first ? 183 : 184
    const chunk = sec.subarray(sent, sent + cap)
    const payload = new Uint8Array(first ? 1 + chunk.length : chunk.length)
    if (first) {
      payload[0] = 0x00
      payload.set(chunk, 1)
    } else {
      payload.set(chunk, 0)
    }
    out.push(buildPacket({ pid, cc: cc & 0x0f, pusi: first, payload }))
    sent += chunk.length
    cc++
    first = false
  }
  return out
}

function pesPayload(streamId: number, fill: number, len = 176): Uint8Array {
  const p = new Uint8Array(len).fill(fill)
  p[0] = 0x00
  p[1] = 0x00
  p[2] = 0x01
  p[3] = streamId
  return p
}

const PCR_EPOCH_BASE = 2 ** 33 // 90 kHz base wrap point

// Packet layout (indices are stable; tests assert against them):
//  0 PAT v0: program 1 -> PMT1
//  1 PMT1 v0: pcr=VIDEO, 0x1B/VIDEO, 0x0F/AUDIO, 0x81/UNKNOWN(+desc)
//  2 VIDEO adaptation-only + PCR (t=10s)
//  3 VIDEO cc0 PES start
//  4 AUDIO cc0 PES start
//  5 VIDEO cc1
//  6 VIDEO cc1 (legal duplicate)
//  7 VIDEO cc3 (gap: cc2 lost)
//  8 AUDIO adaptation-only + discontinuity_indicator
//  9 AUDIO cc7 (allowed reset after discontinuity)
// 10 VIDEO cc4 (proves audio discontinuity did not reset video CC)
// 11 VIDEO cc5 + PCR 5s before 33-bit wrap
// 12 PMT1 v1 section part 1/3 (adds AUDIO2, padded with big descriptors)
// 13 PMT1 v1 section part 2/3
// 14 PMT1 v1 section part 3/3 -> PMT gen 1 starts here
// 15 PMT1 v2 with corrupted CRC -> rejected, no gen
// 16 PMT1 v0 again (version rollback) -> PMT gen 2
// 17 VIDEO cc6 + PCR 5s after wrap (unwrap must stay monotonic)
// 18 PAT v1: program 1 -> PMT2 (program switch) -> PAT gen 1
// 19 PMT2 v0: pcr=VIDEO2, 0x1B/VIDEO2
// 20 VIDEO2 cc0 + PCR
// 21 UNKNOWN cc0 payload
// 22 VIDEO adaptation-only + OPCR
export function buildSampleStream(): Uint8Array {
  const parts: Uint8Array[] = []
  const push = (p: Uint8Array | Uint8Array[]) => {
    for (const x of Array.isArray(p) ? p : [p]) parts.push(x)
  }

  // 0: PAT v0
  push(sectionPackets(PID.PAT, section(0x00, patBody(0, [[1, PID.PMT1]])), 0))
  // 1: PMT1 v0
  push(
    sectionPackets(
      PID.PMT1,
      section(
        0x02,
        pmtBody(0, 1, PID.VIDEO, [
          { type: 0x1b, pid: PID.VIDEO },
          { type: 0x0f, pid: PID.AUDIO },
          { type: 0x81, pid: PID.UNKNOWN, desc: [0x52, 0x01, 0x01] },
        ]),
      ),
      0,
    ),
  )
  // 2: adaptation-only PCR, t=10s
  push(buildPacket({ pid: PID.VIDEO, cc: 0, adaptation: { pcr27: 90000 * 10 * 300 } }))
  // 3: video PES
  push(buildPacket({ pid: PID.VIDEO, cc: 0, pusi: true, payload: pesPayload(0xe0, 0x11) }))
  // 4: audio PES
  push(buildPacket({ pid: PID.AUDIO, cc: 0, pusi: true, payload: pesPayload(0xc0, 0x22) }))
  // 5: video cc1
  push(buildPacket({ pid: PID.VIDEO, cc: 1, payload: pesPayload(0xe0, 0x33) }))
  // 6: legal duplicate of cc1
  push(buildPacket({ pid: PID.VIDEO, cc: 1, payload: pesPayload(0xe0, 0x33) }))
  // 7: cc3 -> one packet (cc2) lost
  push(buildPacket({ pid: PID.VIDEO, cc: 3, payload: pesPayload(0xe0, 0x44) }))
  // 8: audio adaptation-only with discontinuity indicator
  push(buildPacket({ pid: PID.AUDIO, cc: 5, adaptation: { discontinuity: true } }))
  // 9: audio cc7, allowed by discontinuity
  push(buildPacket({ pid: PID.AUDIO, cc: 7, payload: pesPayload(0xc0, 0x55) }))
  // 10: video cc4, unaffected by audio discontinuity
  push(buildPacket({ pid: PID.VIDEO, cc: 4, payload: pesPayload(0xe0, 0x66) }))
  // 11: video cc5 + PCR 5s before wrap
  push(
    buildPacket({
      pid: PID.VIDEO,
      cc: 5,
      adaptation: { pcr27: (PCR_EPOCH_BASE - 450000) * 300 },
      payload: pesPayload(0xe0, 0x77),
    }),
  )
  // 12-14: PMT1 v1 spanning three packets (large program descriptors)
  const bigDesc = [0x05, 0xff, ...new Array(255).fill(0x41), 0x52, 100, ...new Array(100).fill(0x42)]
  const pmtV1 = section(
    0x02,
    pmtBody(
      1,
      1,
      PID.VIDEO,
      [
        { type: 0x1b, pid: PID.VIDEO },
        { type: 0x0f, pid: PID.AUDIO },
        { type: 0x81, pid: PID.UNKNOWN, desc: [0x52, 0x01, 0x01] },
        { type: 0x03, pid: PID.AUDIO2 },
      ],
      bigDesc,
    ),
  )
  if (sectionPackets(PID.PMT1, pmtV1, 1).length !== 3) {
    throw new Error('fixture invariant: PMT v1 must span exactly 3 packets')
  }
  push(sectionPackets(PID.PMT1, pmtV1, 1))
  // 15: PMT1 v2 with corrupted CRC
  const bad = section(
    0x02,
    pmtBody(2, 1, PID.VIDEO, [
      { type: 0x1b, pid: PID.VIDEO },
      { type: 0x0f, pid: PID.AUDIO },
      { type: 0x24, pid: 0x0199 }, // would-be new stream; must never become visible
    ]),
  )
  bad[bad.length - 1] ^= 0xff
  push(sectionPackets(PID.PMT1, bad, 4))
  // 16: PMT1 v0 again (version rollback) -> new generation
  push(
    sectionPackets(
      PID.PMT1,
      section(
        0x02,
        pmtBody(0, 1, PID.VIDEO, [
          { type: 0x1b, pid: PID.VIDEO },
          { type: 0x0f, pid: PID.AUDIO },
          { type: 0x81, pid: PID.UNKNOWN, desc: [0x52, 0x01, 0x01] },
        ]),
      ),
      5,
    ),
  )
  // 17: video cc6 + PCR 5s after wrap
  push(
    buildPacket({
      pid: PID.VIDEO,
      cc: 6,
      adaptation: { pcr27: 450000 * 300 },
      payload: pesPayload(0xe0, 0x88),
    }),
  )
  // 18: PAT v1 -> program switch to PMT2
  push(sectionPackets(PID.PAT, section(0x00, patBody(1, [[1, PID.PMT2]])), 1))
  // 19: PMT2 v0
  push(sectionPackets(PID.PMT2, section(0x02, pmtBody(0, 1, PID.VIDEO2, [{ type: 0x1b, pid: PID.VIDEO2 }])), 0))
  // 20: VIDEO2 cc0 + PCR
  push(
    buildPacket({
      pid: PID.VIDEO2,
      cc: 0,
      adaptation: { pcr27: 90000 * 30 * 300 },
      payload: pesPayload(0xe0, 0x99),
    }),
  )
  // 21: unknown stream payload
  push(buildPacket({ pid: PID.UNKNOWN, cc: 0, payload: pesPayload(0xbd, 0xaa) }))
  // 22: adaptation-only OPCR
  push(buildPacket({ pid: PID.VIDEO, cc: 7, adaptation: { opcr27: 90000 * 40 * 300 } }))

  const out = new Uint8Array(parts.length * 188)
  parts.forEach((p, i) => out.set(p, i * 188))
  return out
}

export interface Fixture {
  name: string
  description: string
  build: () => Uint8Array
}

export const fixtures: Fixture[] = [
  {
    name: 'sample',
    description:
      'PMT 版本回滚、跨三包 section、重复包、纯 adaptation 包、PCR 回绕、错 CRC、节目切换',
    build: buildSampleStream,
  },
]
