const table = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i << 24
  for (let k = 0; k < 8; k++) {
    c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0
  }
  table[i] = c >>> 0
}

export function crc32mpeg(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = (table[((crc >>> 24) ^ data[i]) & 0xff] ^ (crc << 8)) >>> 0
  }
  return crc >>> 0
}

export function crcOk(section: Uint8Array): boolean {
  return crc32mpeg(section) === 0
}
