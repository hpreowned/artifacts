// CRC-32 (IEEE) for zip entries. Node 22 has zlib.crc32; this keeps Node 20 supported.
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

export function crc32(data: Uint8Array, seed: number = 0): number {
  let crc = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) crc = TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}
