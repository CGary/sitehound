import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimal zip reader/writer on Buffers (stored and deflate entries, no zip64, no encryption).
 * Enough for Playwright trace archives; not a general-purpose zip library.
 */

export interface ZipIndexEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Upper bound for one decompressed entry; guards against zip bombs. */
const MAX_ENTRY_SIZE = 512 * 1024 * 1024;

/** Reads the central directory. Throws on zip64, truncated or inconsistent archives. */
export function readZipIndex(buf: Buffer): ZipIndexEntry[] {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 is not supported");
  if (cdOffset + cdSize > buf.length) throw new Error("corrupt zip directory");

  const entries: ZipIndexEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new Error("corrupt zip directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (flags & 1) throw new Error("encrypted zip entries are not supported");
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("zip64 is not supported");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Returns the decompressed bytes of one entry. */
export function readZipEntry(buf: Buffer, entry: ZipIndexEntry): Buffer {
  if (entry.size > MAX_ENTRY_SIZE) throw new Error("zip entry too large");
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error("corrupt zip entry");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error("corrupt zip entry");
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE });
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

let crcTable: Uint32Array | undefined;
function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a zip in memory. Call `add` per entry, then `finish`. */
export class ZipWriter {
  private parts: Buffer[] = [];
  private central: Buffer[] = [];
  private offset = 0;
  private names = new Set<string>();

  add(name: string, data: Buffer | string, { store = false }: { store?: boolean } = {}): void {
    if (this.names.has(name)) throw new Error("duplicate zip entry");
    this.names.add(name);
    const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = store || body.length === 0 ? undefined : deflateRawSync(body);
    const useDeflate = deflated !== undefined && deflated.length < body.length;
    const payload = useDeflate ? deflated : body;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(body);
    if (this.offset + payload.length + nameBuf.length > 0xfffffff0 || payload.length > 0xfffffff0) {
      throw new Error("zip too large (zip64 is not supported)");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(this.offset, 42);

    this.parts.push(local, nameBuf, payload);
    this.central.push(cd, nameBuf);
    this.offset += local.length + nameBuf.length + payload.length;
  }

  finish(): Buffer {
    const cdBuf = Buffer.concat(this.central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(this.names.size, 8);
    eocd.writeUInt16LE(this.names.size, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, cdBuf, eocd]);
  }
}
