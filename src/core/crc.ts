/** CRC-32/MPEG-2（ISO/IEC 13818-1, polynomial 0x04C11DB7，初值 0xFFFFFFFF，
 * 输入不反转、输出不异或）。PSI section 校验覆盖 section_length 声明的全部字节
 * （紧接 table_id 之后到 CRC 结束）。 */

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32Mpeg2(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}
