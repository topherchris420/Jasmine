import { decodeEntities, xmlToJson } from '../integrations/xml.ts';
import { extractPdfPages } from './pdf.ts';
import { readZipEntries } from './zip.ts';

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'markdown' | 'text' | 'csv' | 'json' | 'xml';

export interface ExtractedDocument {
  format: DocumentFormat;
  /** Text per page (PDF), slide (PPTX) or sheet (XLSX); a single entry for flowing text. */
  pages: string[];
  /** CSV/XLSX rows as objects when headers are present. */
  rows?: Record<string, unknown>[];
  title?: string;
}

export interface ExtractOptions {
  filename?: string;
  mime?: string;
  format?: string;
  csv?: CsvOptions;
}

export function detectFormat(bytes: Uint8Array, filename = '', mime = '', hint = ''): DocumentFormat {
  const h = hint.toLowerCase();
  if (h && h !== 'auto') {
    if (h === 'md' || h === 'markdown') return 'markdown';
    if (h === 'txt' || h === 'text') return 'text';
    if (['pdf', 'docx', 'pptx', 'xlsx', 'html', 'csv', 'json', 'xml'].includes(h)) return h as DocumentFormat;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (head.startsWith('%PDF') || ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (head.startsWith('PK')) {
    if (ext === 'pptx' || mime.includes('presentation')) return 'pptx';
    if (ext === 'xlsx' || mime.includes('spreadsheet')) return 'xlsx';
    return 'docx';
  }
  if (ext === 'md' || ext === 'markdown' || mime === 'text/markdown') return 'markdown';
  if (ext === 'csv' || mime === 'text/csv') return 'csv';
  if (ext === 'json' || mime.includes('json')) return 'json';
  if (ext === 'html' || ext === 'htm' || mime.includes('html')) return 'html';
  if (ext === 'xml' || ext === 'rss' || mime.includes('xml')) return 'xml';
  const text = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'html';
  return 'text';
}

export function extractDocument(bytes: Uint8Array, opts: ExtractOptions = {}): ExtractedDocument {
  const format = detectFormat(bytes, opts.filename, opts.mime, opts.format);
  const utf8 = () => Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
  switch (format) {
    case 'pdf': return { format, pages: extractPdfPages(bytes) };
    case 'docx': {
      const files = readZipEntries(bytes, (n) => n === 'word/document.xml');
      const xml = files.get('word/document.xml');
      if (!xml) throw new Error('Not a Word document (word/document.xml missing)');
      return { format, pages: [wordText(xml.toString('utf8'))] };
    }
    case 'pptx': {
      const files = readZipEntries(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      const slides = [...files.entries()].sort((a, b) => slideNo(a[0]) - slideNo(b[0])).map(([, xml]) => drawingText(xml.toString('utf8')));
      return { format, pages: slides };
    }
    case 'xlsx': return extractXlsx(bytes);
    case 'html': {
      const html = utf8();
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
      return { format, pages: [htmlToText(html)], ...(title ? { title: decodeEntities(title.trim()) } : {}) };
    }
    case 'csv': {
      const text = utf8();
      return { format, pages: [text], rows: parseCsv(text, opts.csv) };
    }
    case 'json': {
      const text = utf8();
      try {
        return { format, pages: [JSON.stringify(JSON.parse(text), null, 2)] };
      } catch {
        return { format: 'text', pages: [text] };
      }
    }
    case 'xml': return { format, pages: [JSON.stringify(xmlToJson(utf8()), null, 2)] };
    default: return { format, pages: [utf8()] };
  }
}

const slideNo = (name: string) => Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function wordText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim();
}

function drawingText(xml: string): string {
  return decodeEntities(xml.replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

function extractXlsx(bytes: Uint8Array): ExtractedDocument {
  const files = readZipEntries(bytes, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decodeEntities(m[1]!.replace(/<[^>]+>/g, '')));
  const pages: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const sheets = [...files.entries()].filter(([n]) => n.includes('worksheets')).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  for (const [, xml] of sheets) {
    const grid: string[][] = [];
    for (const row of xml.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
        const attrs = c[1] ?? c[3] ?? '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? '')?.[1] ?? '';
        cells[col] = /t="s"/.test(attrs) ? (shared[Number(v)] ?? '') : decodeEntities(v);
      }
      grid.push(Array.from(cells, (x) => x ?? ''));
    }
    pages.push(grid.map((r) => r.join('\t')).join('\n'));
    const [header, ...body] = grid;
    if (header && rows.length === 0) for (const r of body) rows.push(Object.fromEntries(header.map((h, i) => [h || `column${i + 1}`, r[i] ?? ''])));
  }
  return { format: 'xlsx', pages, rows };
}

/** Readable text from HTML: drops scripts, styles and chrome; keeps headings, paragraphs and list structure. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, '');
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre|header|main)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface CsvOptions {
  delimiter?: string;
  quote?: string;
  headers?: boolean;
  skipRows?: number;
  maxRows?: number;
  trim?: boolean;
  ignoreEmpty?: boolean;
  comment?: string;
}

export function parseCsv(text: string, o: CsvOptions = {}): Record<string, unknown>[] {
  const delimiter = o.delimiter || (text.split('\n', 1)[0]!.includes(';') && !text.split('\n', 1)[0]!.includes(',') ? ';' : ',');
  const quote = o.quote || '"';
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === quote && text[i + 1] === quote) {
        field += quote;
        i++;
      } else if (ch === quote) inQuotes = false;
      else field += ch;
    } else if (ch === quote) inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    records.push(row);
  }
  let lines = records.slice(o.skipRows ?? 0);
  if (o.comment) lines = lines.filter((r) => !(r[0] ?? '').startsWith(o.comment!));
  if (o.ignoreEmpty !== false) lines = lines.filter((r) => r.some((c) => c.trim() !== ''));
  const clean = (v: string) => (o.trim === false ? v : v.trim());
  const useHeaders = o.headers !== false;
  const header = useHeaders ? (lines.shift() ?? []).map((h, i) => clean(h) || `column${i + 1}`) : [];
  const body = o.maxRows ? lines.slice(0, o.maxRows) : lines;
  return body.map((r) => (useHeaders ? Object.fromEntries(header.map((h, i) => [h, clean(r[i] ?? '')])) : Object.fromEntries(r.map((v, i) => [`column${i + 1}`, clean(v)]))));
}
