export interface ChunkOptions {
  /** Maximum characters per chunk. */
  chunkSize?: number;
  /** Characters shared between consecutive chunks. */
  chunkOverlap?: number;
  /** `recursive` splits on paragraphs, lines, sentences, then words; `character` splits on one separator. */
  strategy?: 'recursive' | 'character' | 'sentence' | 'markdown';
  separators?: string[];
}

export const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''];
const MARKDOWN_SEPARATORS = ['\n# ', '\n## ', '\n### ', '\n#### ', '\n```', '\n\n', '\n', '. ', ' ', ''];

/** Splits text into overlapping chunks no longer than `chunkSize` characters, preferring natural boundaries. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = Math.max(1, Math.trunc(opts.chunkSize ?? 1000));
  const overlap = Math.min(Math.max(0, Math.trunc(opts.chunkOverlap ?? Math.min(200, Math.floor(size / 5)))), size - 1);
  const clean = text.replace(/\r\n?/g, '\n');
  if (!clean.trim()) return [];
  const strategy = opts.strategy ?? 'recursive';
  let separators: string[];
  if (opts.separators?.length) separators = opts.separators.map(unescapeSeparator);
  else if (strategy === 'markdown') separators = MARKDOWN_SEPARATORS;
  else if (strategy === 'sentence') separators = ['\n\n', '\n', '. ', '? ', '! ', ' ', ''];
  else if (strategy === 'character') separators = ['\n\n'];
  else separators = DEFAULT_SEPARATORS;
  if (strategy === 'character') return merge(splitKeep(clean, separators[0]!), size, overlap).map((c) => c.trim()).filter(Boolean);
  return recursive(clean, separators, size, overlap).map((c) => c.trim()).filter(Boolean);
}

function unescapeSeparator(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * Splits but keeps the separator with the text: structural separators (newlines, headings) stay at
 * the start of the next piece, sentence and word separators at the end of the previous one.
 */
function splitKeep(text: string, separator: string): string[] {
  if (separator === '') return [...text];
  const parts = text.split(separator);
  if (/^\n/.test(separator)) return parts.map((p, i) => (i === 0 ? p : separator + p)).filter((p) => p !== '');
  return parts.map((p, i) => (i < parts.length - 1 ? p + separator : p)).filter((p) => p !== '');
}

function recursive(text: string, separators: string[], size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const index = separators.findIndex((s) => s === '' || text.includes(s));
  const separator = separators[Math.max(index, 0)] ?? '';
  const rest = separators.slice(Math.max(index, 0) + 1);
  const pieces = splitKeep(text, separator);
  const out: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push(...merge(pending, size, overlap));
    pending = [];
  };
  for (const piece of pieces) {
    if (piece.length <= size) pending.push(piece);
    else {
      flush();
      if (rest.length) out.push(...recursive(piece, rest, size, overlap));
      else out.push(...hardSplit(piece, size, overlap));
    }
  }
  flush();
  return out;
}

function hardSplit(text: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

/** Greedily joins small pieces up to `size`, carrying the tail of the previous chunk forward as overlap. */
function merge(pieces: string[], size: number, overlap: number): string[] {
  const out: string[] = [];
  let window: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    if (window.length && length + piece.length > size) {
      out.push(window.join(''));
      while (window.length && (length > overlap || length + piece.length > size)) length -= window.shift()!.length;
    }
    window.push(piece);
    length += piece.length;
  }
  if (window.length) out.push(window.join(''));
  return out.filter((c) => c.trim() !== '');
}
