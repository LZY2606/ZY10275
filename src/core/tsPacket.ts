import type { TsPacket } from './types'

function parsePcr(b: Uint8Array, o: number): number {
  const base =
    b[o] * 2 ** 25 + b[o + 1] * 2 ** 17 + b[o + 2] * 2 ** 9 + b[o + 3] * 2 + (b[o + 4] >> 7)
  const ext = ((b[o + 4] & 0x01) << 8) | b[o + 5]
  return base * 300 + ext
}

export function parsePacket(index: number, offset: number, b: Uint8Array): TsPacket {
  if (b.length !== 188 || b[0] !== 0x47) throw new Error(`bad packet at ${index}`)
  const tei = (b[1] & 0x80) !== 0
  const pusi = (b[1] & 0x40) !== 0
  const pid = ((b[1] & 0x1f) << 8) | b[2]
  const scrambling = (b[3] & 0xc0) >> 6
  const afc = (b[3] & 0x30) >> 4
  const cc = b[3] & 0x0f
  const pkt: TsPacket = {
    index,
    offset,
    pid,
    tei,
    pusi,
    scrambling,
    afc,
    cc,
    hasPayload: afc === 1 || afc === 3,
    discontinuity: false,
  }
  let pos = 4
  if (afc === 2 || afc === 3) {
    const afl = b[pos]
    const end = pos + 1 + afl
    if (end > 188) throw new Error(`adaptation field overruns packet ${index}`)
    if (afl > 0) {
      const flags = b[pos + 1]
      pkt.discontinuity = (flags & 0x80) !== 0
      let p = pos + 2
      if (flags & 0x10) {
        pkt.pcrRaw = parsePcr(b, p)
        p += 6
      }
      if (flags & 0x08) {
        pkt.opcrRaw = parsePcr(b, p)
        p += 6
      }
    }
    pos = end
  }
  if (pkt.hasPayload && pos < 188) {
    pkt.payload = b.subarray(pos)
  } else if (pkt.hasPayload) {
    pkt.payload = new Uint8Array(0)
  }
  return pkt
}
