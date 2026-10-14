// Minimal zip writer (deflate, unix attrs) used by tests to build corpus bundles, including hostile ones.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "./crc32.js";

export interface ZipInput {
  name: string;
  data: Buffer | string;
  /** Unix mode, e.g. 0o100644 for a file, 0o120777 for a symlink (data = link target), 0o40755 for a dir. */
  mode?: number;
  store?: boolean;
}

export function writeZip(inputs: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const name = Buffer.from(input.name, "utf8");
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, "utf8");
    const method = input.store ? 0 : 8;
    const packed = method === 0 ? data : deflateRawSync(data);
    const crc = crc32(data);
    const mode = input.mode ?? (input.name.endsWith("/") ? 0o40755 : 0o100644);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
