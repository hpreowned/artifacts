// Minimal, strict zip reader: central directory driven, store and deflate only, no zip64, no encryption.
// Owning this parser is deliberate: it is the security boundary for zip-slip, symlinks and decompression bombs.
import { inflateRawSync } from "node:zlib";
import { crc32 } from "./crc32.js";

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Any unix file type other than regular file or directory (device, fifo, socket). */
  isSpecial: boolean;
  compressedSize: number;
  uncompressedSize: number;
  /** Inflates and CRC-checks the entry. `maxBytes` caps the output regardless of the declared size. */
  read(maxBytes: number): Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 archives are not supported");
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new ZipError("multi-disk archives are not supported");
  if (cdOffset + cdSize > eocd) throw new ZipError("central directory out of bounds");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipError("bad central directory entry");
    const hostOs = buf.readUInt16LE(p + 4) >>> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) throw new ZipError("bad central directory entry");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (flags & 0x0001) throw new ZipError(`encrypted entry: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression method ${method}: ${name}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new ZipError("zip64 entry sizes are not supported");

    const unixMode = hostOs === 3 ? externalAttrs >>> 16 : 0;
    const typeBits = unixMode & 0xf000;
    const isDirectory = name.endsWith("/") || typeBits === 0x4000 || (hostOs !== 3 && (externalAttrs & 0x10) !== 0);
    const isSymlink = typeBits === 0xa000;
    const isSpecial = typeBits !== 0 && typeBits !== 0x8000 && typeBits !== 0x4000 && typeBits !== 0xa000;

    entries.push({
      name, isDirectory, isSymlink, isSpecial, compressedSize, uncompressedSize,
      read: (maxBytes) => readEntry(buf, localOffset, method, compressedSize, uncompressedSize, crc, maxBytes, name),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEocd(buf: Buffer): number {
  if (buf.length < 22) throw new ZipError("not a zip file (too small)");
  const stop = Math.max(0, buf.length - 22 - MAX_COMMENT);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new ZipError("not a zip file (no end-of-central-directory record)");
}

function readEntry(
  buf: Buffer, localOffset: number, method: number, compressedSize: number, uncompressedSize: number,
  crc: number, maxBytes: number, name: string,
): Buffer {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new ZipError(`bad local header: ${name}`);
  const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  if (dataStart + compressedSize > buf.length) throw new ZipError(`entry data out of bounds: ${name}`);
  if (uncompressedSize > maxBytes) throw new ZipError(`entry larger than ${maxBytes} bytes: ${name}`);
  const raw = buf.subarray(dataStart, dataStart + compressedSize);
  let data: Buffer;
  if (method === 0) {
    data = Buffer.from(raw);
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch (err) {
      throw new ZipError(`inflate failed: ${name} (${(err as Error).message})`);
    }
  }
  if (data.length !== uncompressedSize) throw new ZipError(`size mismatch: ${name}`);
  if (crc32(data) !== crc) throw new ZipError(`crc mismatch: ${name}`);
  return data;
}
