// Tiny ZIP reader for tests: walks the central directory and inflates each entry. Not for untrusted input.
import { inflateRawSync } from "node:zlib";

export interface Unzipped {
  name: string;
  data: Buffer;
  method: number;
  crc: number;
  flags: number;
}

export function unzip(zip: Buffer): Unzipped[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: Unzipped[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lnlen = zip.readUInt16LE(offset + 26);
    const lelen = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + lnlen + lelen;
    const payload = zip.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    out.push({ name, data, method, crc, flags });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
