import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { EngineError } from '../errors.ts';

export function pageNumbers(spec: unknown, count: number, duplicates = false): number[] {
  const text = Array.isArray(spec) ? spec.join(',') : String(spec ?? '');
  if (!text.trim()) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new EngineError('BAD_PAYLOAD', 'Use page numbers and ascending ranges, such as 1-3,5');
    const start = Number(m[1]),
      end = Number(m[2] ?? m[1]);
    if (start < 1 || end > count || end < start)
      throw new EngineError('BAD_PAYLOAD', `Page range is outside 1–${count}`);
    for (let n = start; n <= end; n++) out.push(n - 1);
  }
  return duplicates ? out : [...new Set(out)];
}
export interface Bookmark {
  title: string;
  page: number;
  children?: Bookmark[];
}
export function readBookmarks(doc: PDFDocument): Bookmark[] {
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (!root) return [];
  const seen = new Set<string>();
  const pages = doc.getPages();
  const walk = (ref: PDFRef | undefined, depth: number): Bookmark[] => {
    const out: Bookmark[] = [];
    while (ref && depth < 10 && out.length < 500) {
      if (seen.has(ref.toString())) break;
      seen.add(ref.toString());
      const item = doc.context.lookup(ref, PDFDict);
      const title = item.get(PDFName.of('Title'));
      const dest = item.lookupMaybe(PDFName.of('Dest'), PDFArray);
      const pageRef = dest?.get(0);
      let page = pages.findIndex((p) => String(p.ref) === String(pageRef)) + 1;
      if (!page) page = 1;
      const children = walk(item.get(PDFName.of('First')) as PDFRef | undefined, depth + 1);
      out.push({
        title: title instanceof PDFString || title instanceof PDFHexString ? title.decodeText() : 'Untitled',
        page,
        ...(children.length ? { children } : {}),
      });
      ref = item.get(PDFName.of('Next')) as PDFRef | undefined;
    }
    return out;
  };
  return walk(root.get(PDFName.of('First')) as PDFRef | undefined, 0);
}
export function setBookmarks(doc: PDFDocument, bookmarks: Bookmark[]): void {
  if (!Array.isArray(bookmarks) || bookmarks.length > 500)
    throw new EngineError('BAD_PAYLOAD', 'Bookmarks must be an array of at most 500 items');
  const root = doc.context.obj({ Type: 'Outlines' }),
    rootRef = doc.context.register(root);
  let total = 0;
  const build = (items: Bookmark[], parent: PDFRef, depth: number): PDFRef[] => {
    if (depth > 10) throw new EngineError('BAD_PAYLOAD', 'Bookmark depth exceeds 10');
    const refs: PDFRef[] = [],
      dicts: PDFDict[] = [];
    for (const item of items) {
      if (
        ++total > 500 ||
        typeof item.title !== 'string' ||
        !Number.isInteger(item.page) ||
        item.page < 1 ||
        item.page > doc.getPageCount()
      )
        throw new EngineError('BAD_PAYLOAD', 'Invalid bookmark title/page');
      const d = doc.context.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        Dest: [doc.getPages()[item.page - 1]!.ref, 'Fit'],
      });
      dicts.push(d);
      refs.push(doc.context.register(d));
    }
    refs.forEach((ref, i) => {
      const d = dicts[i]!;
      if (i) d.set(PDFName.of('Prev'), refs[i - 1]!);
      if (i + 1 < refs.length) d.set(PDFName.of('Next'), refs[i + 1]!);
      const children = build(items[i]!.children ?? [], ref, depth + 1);
      if (children.length) {
        d.set(PDFName.of('First'), children[0]!);
        d.set(PDFName.of('Last'), children.at(-1)!);
        d.set(PDFName.of('Count'), PDFNumber.of(children.length));
      }
    });
    return refs;
  };
  const refs = build(bookmarks, rootRef, 0);
  if (refs.length) {
    root.set(PDFName.of('First'), refs[0]!);
    root.set(PDFName.of('Last'), refs.at(-1)!);
    root.set(PDFName.of('Count'), PDFNumber.of(total));
    doc.catalog.set(PDFName.of('Outlines'), rootRef);
  } else doc.catalog.delete(PDFName.of('Outlines'));
}

export async function editPdf(
  inputs: Uint8Array[],
  v: Record<string, unknown>,
): Promise<{ bytes?: Uint8Array[]; pageCounts?: number[]; metadata?: unknown; bookmarks?: Bookmark[] }> {
  if (!inputs.length || inputs.length > 50) throw new EngineError('BAD_PAYLOAD', 'Provide 1–50 documents');
  const docs = await Promise.all(inputs.map((b) => PDFDocument.load(b, { updateMetadata: false })));
  const doc = docs[0]!,
    type = String(v['type'] ?? 'pages').toLowerCase(),
    operation = String(v['operation'] ?? 'extract').toLowerCase();
  const copy = async (source: PDFDocument, pages: number[]) => {
    const target = await PDFDocument.create();
    for (const p of await target.copyPages(source, pages)) target.addPage(p);
    return target;
  };
  let results: PDFDocument[] = [];
  if (type === 'merge') {
    const target = await PDFDocument.create();
    const outlines: Bookmark[] = [];
    for (let i = 0; i < docs.length; i++) {
      const source = docs[i]!,
        ranges = (v['pageRanges'] as unknown[] | undefined)?.[i];
      const selection = pageNumbers(ranges, source.getPageCount());
      const offset = target.getPageCount();
      for (const p of await target.copyPages(source, selection)) target.addPage(p);
      if (v['preserveBookmarks'] !== false) {
        const remap = (items: Bookmark[]): Bookmark[] =>
          items.flatMap((b) => {
            const children = remap(b.children ?? []),
              found = selection.indexOf(b.page - 1);
            return found < 0
              ? children
              : [{ title: b.title, page: offset + found + 1, ...(children.length ? { children } : {}) }];
          });
        outlines.push(...remap(readBookmarks(source)));
      }
    }
    if (outlines.length) setBookmarks(target, outlines);
    results = [target];
  } else if (type === 'split') {
    const count = doc.getPageCount();
    let groups: number[][] = [];
    if (operation === 'everypage') groups = Array.from({ length: count }, (_, i) => [i]);
    else if (operation === 'atpages') {
      const starts = [0, ...pageNumbers(v['pages'], count).filter((n) => n > 0)].sort((a, b) => a - b);
      groups = starts.map((start, i) => Array.from({ length: (starts[i + 1] ?? count) - start }, (_, n) => start + n));
    } else {
      const size = Number(v['pagesPerFile'] ?? 1);
      if (!Number.isInteger(size) || size < 1) throw new EngineError('BAD_PAYLOAD', 'pagesPerFile must be positive');
      for (let start = 0; start < count; start += size)
        groups.push(Array.from({ length: Math.min(size, count - start) }, (_, i) => start + i));
    }
    results = await Promise.all(groups.map((p) => copy(doc, p)));
  } else if (type === 'metadata') {
    if (operation === 'get')
      return {
        metadata: {
          title: doc.getTitle() ?? '',
          author: doc.getAuthor() ?? '',
          subject: doc.getSubject() ?? '',
          creator: doc.getCreator() ?? '',
          keywords: doc.getKeywords() ?? '',
        },
      };
    if (operation !== 'set') throw new EngineError('BAD_PAYLOAD', 'Metadata operation must be get or set');
    for (const [key, set] of [
      ['title', doc.setTitle.bind(doc)],
      ['author', doc.setAuthor.bind(doc)],
      ['subject', doc.setSubject.bind(doc)],
      ['creator', doc.setCreator.bind(doc)],
    ] as const)
      if (v[key] !== undefined) set(String(v[key]));
    if (v['keywords'] !== undefined)
      doc.setKeywords(Array.isArray(v['keywords']) ? v['keywords'].map(String) : String(v['keywords']).split(','));
    results = [doc];
  } else if (type === 'bookmarks') {
    if (operation === 'list') return { bookmarks: readBookmarks(doc) };
    if (!['set', 'remove'].includes(operation))
      throw new EngineError('BAD_PAYLOAD', 'Bookmark operation must be list, set or remove');
    const items = operation === 'remove' ? [] : (v['bookmarks'] as Bookmark[]);
    setBookmarks(doc, v['replaceBookmarks'] === false ? [...readBookmarks(doc), ...items] : items);
    results = [doc];
  } else if (type === 'pages') {
    if (operation === 'extract') results = [await copy(doc, pageNumbers(v['pages'], doc.getPageCount()))];
    else if (operation === 'delete') {
      const selected = new Set(pageNumbers(v['pages'], doc.getPageCount()));
      const keep = Array.from({ length: doc.getPageCount() }, (_, i) => i).filter((i) => !selected.has(i));
      if (!keep.length) throw new EngineError('BAD_PAYLOAD', 'Cannot delete every page');
      results = [await copy(doc, keep)];
    } else if (operation === 'reorder')
      results = [await copy(doc, pageNumbers(v['pageOrder'], doc.getPageCount(), true))];
    else if (operation === 'insertblank' || operation === 'insertdocument') {
      const position = Number(v['position'] ?? doc.getPageCount());
      if (!Number.isInteger(position) || position < 0 || position > doc.getPageCount())
        throw new EngineError('BAD_PAYLOAD', 'Position must be 0 through page count');
      if (operation === 'insertblank') {
        const count = Number(v['count'] ?? 1);
        if (!Number.isInteger(count) || count < 1 || count > 100)
          throw new EngineError('BAD_PAYLOAD', 'Blank page count must be 1–100');
        for (let i = 0; i < count; i++) doc.insertPage(position + i);
      } else {
        if (!docs[1]) throw new EngineError('BAD_PAYLOAD', 'A source document is required');
        const pages = await doc.copyPages(docs[1], pageNumbers(v['sourcePages'], docs[1].getPageCount()));
        pages.forEach((p, i) => doc.insertPage(position + i, p));
      }
      results = [doc];
    } else throw new EngineError('BAD_PAYLOAD', `Unknown page operation: ${operation}`);
  } else throw new EngineError('BAD_PAYLOAD', `Unknown document operation type: ${type}`);
  return { bytes: await Promise.all(results.map((d) => d.save())), pageCounts: results.map((d) => d.getPageCount()) };
}
