export type PacketSize = 188 | 192 | 204

function syncOffset(size: PacketSize): number {
  return size === 192 ? 4 : 0
}

export function detectPacketSize(buf: Uint8Array): PacketSize {
  const candidates: PacketSize[] = [188, 192, 204]
  let best: PacketSize = 188
  let bestScore = -1
  for (const size of candidates) {
    const off = syncOffset(size)
    let score = 0
    for (let i = 0; i < 5; i++) {
      const pos = off + i * size
      if (pos >= buf.length) break
      if (buf[pos] === 0x47) score++
      else break
    }
    if (score > bestScore) {
      bestScore = score
      best = size
    }
  }
  if (bestScore === 0) throw new Error('no sync byte 0x47 found; not a MPEG-TS buffer')
  return best
}

export function* iterPackets(
  buf: Uint8Array,
  size: PacketSize,
): Generator<{ index: number; offset: number; bytes: Uint8Array }> {
  const off = syncOffset(size)
  let index = 0
  for (let pos = 0; pos + off + 188 <= buf.length; pos += size) {
    const bytes = buf.subarray(pos + off, pos + off + 188)
    if (bytes[0] !== 0x47) {
      throw new Error(`sync lost at packet ${index} (offset ${pos + off})`)
    }
    yield { index, offset: pos, bytes }
    index++
  }
}
