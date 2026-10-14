// Minimal deterministic ZIP writer: files at the root, deflate or store, fixed timestamps, no extra fields.
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const FLAG_UTF8 = 0x0800;

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const common = Buffer.concat([
      u16(20), u16(FLAG_UTF8), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(payload.length), u32(e.data.length), u16(name.length),
    ]);
    const local = Buffer.concat([u32(0x04034b50), common, u16(0), name, payload]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}
