import { inflateSync } from 'node:zlib';

/**
 * Text extraction for typical PDFs: classic and compressed (object-stream) files, FlateDecode content,
 * simple fonts and Type0 fonts with ToUnicode maps. Scanned images need OCR and yield no text.
 */
type PdfValue = number | boolean | null | string | PdfName | PdfRef | PdfString | PdfValue[] | PdfDict;
interface PdfName { name: string }
interface PdfRef { ref: number }
interface PdfString { bytes: string }
interface PdfDict { [key: string]: PdfValue }
interface PdfObject { dict: PdfDict | null; value: PdfValue; stream?: Buffer }

const isName = (v: unknown): v is PdfName => !!v && typeof v === 'object' && 'name' in v;
const isRef = (v: unknown): v is PdfRef => !!v && typeof v === 'object' && 'ref' in v;
const isStr = (v: unknown): v is PdfString => !!v && typeof v === 'object' && 'bytes' in v;
const isDict = (v: unknown): v is PdfDict => !!v && typeof v === 'object' && !Array.isArray(v) && !isName(v) && !isRef(v) && !isStr(v);

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set('()<>[]{}/%');

class Lexer {
  pos: number;
  readonly s: string;
  constructor(s: string, pos = 0) {
    this.s = s;
    this.pos = pos;
  }

  skip(): void {
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (WHITESPACE.has(c)) this.pos++;
      else if (this.s[this.pos] === '%') {
        while (this.pos < this.s.length && this.s[this.pos] !== '\n' && this.s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }

  /** Reads one value; returns an operator token as `{ op }` when it meets a bare keyword. */
  value(): PdfValue | { op: string } | undefined {
    this.skip();
    if (this.pos >= this.s.length) return undefined;
    const ch = this.s[this.pos]!;
    if (ch === '/') {
      let end = this.pos + 1;
      while (end < this.s.length && !WHITESPACE.has(this.s.charCodeAt(end)) && !DELIMS.has(this.s[end]!)) end++;
      const name = this.s.slice(this.pos + 1, end).replace(/#([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      this.pos = end;
      return { name };
    }
    if (ch === '(') return { bytes: this.literal() };
    if (ch === '<' && this.s[this.pos + 1] === '<') {
      this.pos += 2;
      const dict: PdfDict = {};
      for (;;) {
        this.skip();
        if (this.s.startsWith('>>', this.pos)) {
          this.pos += 2;
          return dict;
        }
        const key = this.value();
        if (key === undefined) return dict;
        if (!isName(key)) continue;
        const v = this.value();
        if (v === undefined) return dict;
        dict[key.name] = isOp(v) ? null : v;
      }
    }
    if (ch === '<') {
      const end = this.s.indexOf('>', this.pos);
      const hex = this.s.slice(this.pos + 1, end < 0 ? this.s.length : end).replace(/\s+/g, '');
      this.pos = end < 0 ? this.s.length : end + 1;
      let bytes = '';
      for (let i = 0; i < hex.length; i += 2) bytes += String.fromCharCode(parseInt((hex.slice(i, i + 2) + '0').slice(0, 2), 16));
      return { bytes };
    }
    if (ch === '[') {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.s[this.pos] === ']') {
          this.pos++;
          return arr;
        }
        const v = this.value();
        if (v === undefined) return arr;
        if (isOp(v)) {
          if (v.op === 'R' && arr.length >= 2) {
            arr.pop();
            const num = arr.pop();
            arr.push({ ref: Number(num) });
          }
          continue;
        }
        arr.push(v);
      }
    }
    if (ch === ']' || ch === '>' || ch === ')' || ch === '{' || ch === '}') {
      this.pos++;
      return { op: ch };
    }
    let end = this.pos;
    while (end < this.s.length && !WHITESPACE.has(this.s.charCodeAt(end)) && !DELIMS.has(this.s[end]!)) end++;
    if (end === this.pos) end++;
    const token = this.s.slice(this.pos, end);
    this.pos = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      // `n g R` inside dictionaries.
      const save = this.pos;
      const m = /^\s+(\d+)\s+R(?![A-Za-z])/.exec(this.s.slice(this.pos, this.pos + 24));
      if (m && /^\d+$/.test(token)) {
        this.pos = save + m[0].length;
        return { ref: Number(token) };
      }
      return Number(token);
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return { op: token };
  }

  private literal(): string {
    let depth = 0;
    let out = '';
    this.pos++;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos++]!;
      if (c === '\\') {
        const n = this.s[this.pos++] ?? '';
        if (n === 'n') out += '\n';
        else if (n === 'r') out += '\r';
        else if (n === 't') out += '\t';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(this.s[this.pos] ?? '')) oct += this.s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (n === '\r') {
          if (this.s[this.pos] === '\n') this.pos++;
        } else if (n !== '\n') out += n;
      } else if (c === '(') {
        depth++;
        out += c;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
        out += c;
      } else out += c;
    }
    return out;
  }
}

const isOp = (v: unknown): v is { op: string } => !!v && typeof v === 'object' && 'op' in v;

function decodeStream(dict: PdfDict | null, raw: Buffer): Buffer {
  const filter = dict?.['Filter'];
  const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
  let data = raw;
  for (const f of filters) {
    if (!isName(f)) continue;
    if (f.name === 'FlateDecode' || f.name === 'Fl') {
      try {
        data = inflateSync(data);
      } catch {
        data = inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
      }
    } else if (f.name === 'ASCIIHexDecode' || f.name === 'AHx') {
      const hex = data.toString('latin1').replace(/[^0-9a-f]/gi, '');
      data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    } else {
      return Buffer.alloc(0);
    }
  }
  return data;
}

class PdfDocument {
  readonly objects = new Map<number, PdfObject>();
  readonly text: string;

  constructor(data: Buffer) {
    this.text = data.toString('latin1');
    if (!this.text.startsWith('%PDF')) throw new Error('Not a PDF file');
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text))) {
      const num = Number(m[1]);
      const lexer = new Lexer(this.text, m.index + m[0].length);
      const value = lexer.value();
      if (value === undefined || isOp(value)) continue;
      const obj: PdfObject = { dict: isDict(value) ? value : null, value };
      lexer.skip();
      if (this.text.startsWith('stream', lexer.pos)) {
        let start = lexer.pos + 6;
        if (this.text[start] === '\r') start++;
        if (this.text[start] === '\n') start++;
        const declared = obj.dict?.['Length'];
        let end = typeof declared === 'number' && this.text.startsWith('endstream', skipWs(this.text, start + declared)) ? start + declared : -1;
        if (end < 0) {
          end = this.text.indexOf('endstream', start);
          if (end < 0) continue;
          while (end > start && (this.text[end - 1] === '\n' || this.text[end - 1] === '\r')) end--;
        }
        obj.stream = data.subarray(start, end);
        re.lastIndex = end;
      }
      this.objects.set(num, obj);
    }
    for (const [, obj] of [...this.objects]) {
      if (isName(obj.dict?.['Type']) && (obj.dict!['Type'] as PdfName).name === 'ObjStm' && obj.stream) this.expandObjectStream(obj);
    }
  }

  get encrypted(): boolean {
    return /\/Encrypt\s+\d+\s+\d+\s+R/.test(this.text);
  }

  private expandObjectStream(obj: PdfObject): void {
    const body = decodeStream(obj.dict, obj.stream!).toString('latin1');
    const n = Number(obj.dict!['N'] ?? 0);
    const first = Number(obj.dict!['First'] ?? 0);
    const header = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2]!;
      const offset = header[i * 2 + 1]!;
      if (this.objects.has(num)) continue;
      const value = new Lexer(body, first + offset).value();
      if (value === undefined || isOp(value)) continue;
      this.objects.set(num, { dict: isDict(value) ? value : null, value });
    }
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let cur = v;
    for (let i = 0; i < 16 && isRef(cur); i++) cur = this.objects.get(cur.ref)?.value;
    return cur;
  }

  streamOf(v: PdfValue | undefined): Buffer | undefined {
    if (!isRef(v)) return undefined;
    const obj = this.objects.get(v.ref);
    return obj?.stream ? decodeStream(obj.dict, obj.stream) : undefined;
  }

  pages(): PdfDict[] {
    const root = /\/Root\s+(\d+)\s+\d+\s+R/g;
    let rootRef: number | undefined;
    let m: RegExpExecArray | null;
    while ((m = root.exec(this.text))) rootRef = Number(m[1]);
    if (rootRef === undefined) {
      for (const obj of this.objects.values()) if (isName(obj.dict?.['Type']) && (obj.dict!['Type'] as PdfName).name === 'Catalog') rootRef = -1;
    }
    const catalog = rootRef !== undefined && rootRef >= 0 ? this.resolve({ ref: rootRef }) : [...this.objects.values()].find((o) => isName(o.dict?.['Type']) && (o.dict!['Type'] as PdfName).name === 'Catalog')?.dict;
    const out: PdfDict[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfValue | undefined, inherited: PdfDict) => {
      const dict = this.resolve(node);
      if (!isDict(dict) || seen.has(dict) || out.length > 5000) return;
      seen.add(dict);
      const resources = dict['Resources'] !== undefined ? (this.resolve(dict['Resources']) as PdfDict) : inherited['Resources'] as PdfDict;
      const type = isName(dict['Type']) ? dict['Type'].name : undefined;
      if (type === 'Pages' || Array.isArray(this.resolve(dict['Kids']))) {
        for (const kid of (this.resolve(dict['Kids']) as PdfValue[]) ?? []) walk(kid, { Resources: resources ?? null });
      } else {
        out.push({ ...dict, Resources: resources ?? null });
      }
    };
    if (isDict(catalog)) walk(catalog['Pages'], {});
    if (out.length === 0) {
      for (const obj of this.objects.values()) if (isName(obj.dict?.['Type']) && (obj.dict!['Type'] as PdfName).name === 'Page') out.push(obj.dict!);
    }
    return out;
  }
}

function skipWs(s: string, i: number): number {
  while (i < s.length && WHITESPACE.has(s.charCodeAt(i))) i++;
  return i;
}

interface Font {
  bytesPerCode: 1 | 2;
  map: Map<number, string> | undefined;
}

function parseCMap(text: string): { map: Map<number, string>; bytes: 1 | 2 } {
  const map = new Map<number, string>();
  const hexToStr = (hex: string) => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length % 4 === 2) out += String.fromCharCode(parseInt(hex.slice(-2), 16));
    return out;
  };
  let bytes: 1 | 2 = 2;
  const codespace = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(text);
  if (codespace && codespace[1]!.length <= 2) bytes = 1;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(pair[1]!, 16), hexToStr(pair[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(range[1]!, 16);
      const hi = Math.min(parseInt(range[2]!, 16), lo + 65_535);
      if (range[4] !== undefined) {
        const base = hexToStr(range[4]);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      } else if (range[5] !== undefined) {
        const items = [...range[5].matchAll(/<([0-9a-f]*)>/gi)].map((x) => hexToStr(x[1]!));
        items.forEach((s, i) => map.set(lo + i, s));
      }
    }
  }
  return { map, bytes };
}

function fontsFor(doc: PdfDocument, page: PdfDict): Map<string, Font> {
  const fonts = new Map<string, Font>();
  const resources = doc.resolve(page['Resources']);
  if (!isDict(resources)) return fonts;
  const fontDict = doc.resolve(resources['Font']);
  if (!isDict(fontDict)) return fonts;
  for (const [name, ref] of Object.entries(fontDict)) {
    const font = doc.resolve(ref);
    if (!isDict(font)) continue;
    const type0 = isName(font['Subtype']) && font['Subtype'].name === 'Type0';
    const cmapStream = doc.streamOf(font['ToUnicode']);
    if (cmapStream) {
      const { map, bytes } = parseCMap(cmapStream.toString('latin1'));
      fonts.set(name, { bytesPerCode: type0 ? 2 : bytes, map });
    } else fonts.set(name, { bytesPerCode: type0 ? 2 : 1, map: undefined });
  }
  return fonts;
}

function decodeText(bytes: string, font: Font | undefined): string {
  if (!font) return bytes.replace(/[\x00-\x08\x0e-\x1f]/g, '');
  let out = '';
  if (font.bytesPerCode === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
      out += font.map?.get(code) ?? (font.map ? '' : String.fromCharCode(code));
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes.charCodeAt(i);
      out += font.map?.get(code) ?? String.fromCharCode(code);
    }
  }
  return out;
}

function contentText(content: string, fonts: Map<string, Font>): string {
  const lexer = new Lexer(content);
  const stack: (PdfValue | { op: string })[] = [];
  let font: Font | undefined;
  let out = '';
  let lastY: number | undefined;
  const newline = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const emit = (s: string) => {
    out += s;
  };
  for (let guard = 0; guard < 5_000_000; guard++) {
    const token = lexer.value();
    if (token === undefined) break;
    if (!isOp(token)) {
      stack.push(token);
      continue;
    }
    const args = stack.splice(0);
    switch (token.op) {
      case 'BI': {
        const end = content.indexOf('EI', lexer.pos);
        lexer.pos = end < 0 ? content.length : end + 2;
        break;
      }
      case 'Tf': {
        const name = args.find(isName);
        font = name ? fonts.get(name.name) : undefined;
        break;
      }
      case 'Tj':
      case "'":
      case '"': {
        if (token.op !== 'Tj') newline();
        const s = args.findLast(isStr);
        if (s) emit(decodeText(s.bytes, font));
        break;
      }
      case 'TJ': {
        const arr = args.find(Array.isArray) as PdfValue[] | undefined;
        for (const item of arr ?? []) {
          if (isStr(item)) emit(decodeText(item.bytes, font));
          else if (typeof item === 'number' && item < -180 && !out.endsWith(' ')) emit(' ');
        }
        break;
      }
      case 'Td':
      case 'TD': {
        const ty = Number(args[1] ?? 0);
        if (Math.abs(ty) > 0.5) newline();
        else if (Number(args[0] ?? 0) > 1 && !out.endsWith(' ') && !out.endsWith('\n')) emit(' ');
        break;
      }
      case 'Tm': {
        const y = Number(args[5] ?? 0);
        if (lastY !== undefined && Math.abs(y - lastY) > 0.5) newline();
        else if (lastY !== undefined && !out.endsWith(' ') && !out.endsWith('\n')) emit(' ');
        lastY = y;
        break;
      }
      case 'T*':
        newline();
        break;
      case 'ET':
        if (!out.endsWith('\n') && !out.endsWith(' ')) emit(' ');
        break;
      default:
        break;
    }
  }
  return out;
}

export function extractPdfText(data: Uint8Array): string {
  return extractPdfPages(data).filter(Boolean).join('\n\n');
}

/** One string per page. */
export function extractPdfPages(data: Uint8Array): string[] {
  const doc = new PdfDocument(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  if (doc.encrypted) throw new Error('Encrypted PDFs are not supported; remove the password and re-upload');
  const pages: string[] = [];
  for (const page of doc.pages()) {
    const fonts = fontsFor(doc, page);
    const contents = page['Contents'];
    const parts = Array.isArray(doc.resolve(contents)) ? (doc.resolve(contents) as PdfValue[]) : [contents];
    let content = '';
    for (const part of parts) content += `${doc.streamOf(part as PdfValue)?.toString('latin1') ?? ''}\n`;
    pages.push(contentText(content, fonts).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  return pages;
}
