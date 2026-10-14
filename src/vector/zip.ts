import { inflateRawSync } from 'node:zlib';

/** Minimal ZIP reader (stored + deflate entries) for DOCX/PPTX/XLSX text extraction. */
export function readZipEntries(data: Uint8Array, wanted: (name: string) => boolean, maxBytes = 50_000_000): Map<string, Buffer> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    total += size;
    if (total > maxBytes) throw new Error('ZIP content exceeds the extraction limit');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt ZIP local header');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compressedSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) + 1024 }));
  }
  return out;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a ZIP archive');
}
