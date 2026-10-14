import { deflateRawSync, deflateSync } from 'node:zlib';

/** Minimal ZIP writer (deflate) for DOCX/PPTX fixtures. */
export function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, compressed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

export function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
  });
}

export function pptx(slides: string[]): Uint8Array {
  return zip(Object.fromEntries(slides.map((s, i) => [`ppt/slides/slide${i + 1}.xml`, `<p:sld><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:sld>`])));
}

/**
 * A two-page PDF 1.5 file: page 1 uses a simple font and a FlateDecode stream; page 2 uses a Type0
 * (Identity-H) font whose dictionary lives in a compressed object stream and maps glyphs via ToUnicode.
 */
export function pdf(page1: string, page2: string): Uint8Array {
  const glyphs = [...new Set(page2)];
  const gid = (ch: string) => glyphs.indexOf(ch) + 3;
  const hex = [...page2].map((ch) => gid(ch).toString(16).padStart(4, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
${glyphs.length} beginbfchar
${glyphs.map((ch) => `<${gid(ch).toString(16).padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')}
endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const content1 = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${page1.replace(/[()\\]/g, '\\$&')}) Tj ET`));
  const content2 = deflateSync(Buffer.from(`BT /F2 12 Tf 72 720 Td <${hex}> Tj 0 -20 Td [<${hex.slice(0, 8)}> -300 <${hex.slice(8)}>] TJ ET`));
  const cmapStream = deflateSync(Buffer.from(cmap));
  const objStmBody = '9 0 << /Type /Font /Subtype /Type0 /BaseFont /Demo /Encoding /Identity-H /ToUnicode 8 0 R >>';
  const objStm = deflateSync(Buffer.from(objStmBody));
  const parts: (string | Buffer)[] = ['%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'];
  const add = (s: string | Buffer) => parts.push(s);
  add('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  add('2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n');
  add('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >> endobj\n');
  add('4 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F2 9 0 R >> >> /Contents 6 0 R >> endobj\n');
  add(`5 0 obj << /Length ${content1.length} /Filter /FlateDecode >>\nstream\n`); add(content1); add('\nendstream endobj\n');
  add(`6 0 obj << /Length ${content2.length} /Filter /FlateDecode >>\nstream\n`); add(content2); add('\nendstream endobj\n');
  add('7 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  add(`8 0 obj << /Length ${cmapStream.length} /Filter /FlateDecode >>\nstream\n`); add(cmapStream); add('\nendstream endobj\n');
  add(`10 0 obj << /Type /ObjStm /N 1 /First 4 /Length ${objStm.length} /Filter /FlateDecode >>\nstream\n`); add(objStm); add('\nendstream endobj\n');
  add('trailer << /Root 1 0 R >>\n%%EOF\n');
  return new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p))));
}
