/**
 * Turns Markdown documentation (READMEs, docs pages) into plain sections a knowledge collection can search: badges,
 * images, HTML and long code listings are dropped, links keep their text, tables become lines of cells. Used for
 * Jasmine's own documentation and for the knowledge packs built from other repositories.
 */

export interface MarkdownSection {
  /** The section's heading, or the document title for text before the first section heading. */
  heading: string;
  /** Heading depth: 1 for the title section, 2 for `##` sections. */
  level: number;
  /** GitHub-style anchor of the heading, for links into the rendered page. */
  anchor: string;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', middot: '·', times: '×' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** GitHub's heading anchors: lower case, punctuation removed, spaces as hyphens. */
export function headingAnchor(heading: string): string {
  return heading.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Inline Markdown to plain text: images and badges removed, links reduced to their text, emphasis and code marks dropped. */
function inline(line: string): string {
  return line
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

/** Strips HTML, keeping the text of elements; block elements become line breaks. */
function stripHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|picture|svg|video|audio)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, '\n$1:\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/?(p|div|details|section|table|tr|ul|ol|li|h[1-6]|blockquote|center|sub|sup)\b[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, '');
}

const ALERTS: Record<string, string> = { NOTE: 'Note:', TIP: 'Tip:', IMPORTANT: 'Important:', WARNING: 'Warning:', CAUTION: 'Caution:' };

/**
 * Plain text for one stretch of Markdown. Fenced code is kept when short (commands people ask about) and replaced by
 * nothing when long; table rows become cells joined by “ — ”.
 */
export function cleanMarkdown(markdown: string, opts: { maxCodeChars?: number } = {}): string {
  const maxCode = opts.maxCodeChars ?? 400;
  const out: string[] = [];
  let fence: { marker: string; lines: string[] } | undefined;
  let pendingAlert: string | undefined;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence.marker)) {
        const code = fence.lines.join('\n').trim();
        if (code && code.length <= maxCode) out.push(code);
        fence = undefined;
      } else fence.lines.push(raw);
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]!, lines: [] };
      continue;
    }
    let line = raw;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).filter(Boolean).join(' — ');
    }
    line = line.replace(/^\s*>\s?/, '');
    // A GitHub alert marker on its own line labels the line that follows it.
    const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/.exec(line);
    if (alert) {
      if (!alert[2]) {
        pendingAlert = ALERTS[alert[1]!]!;
        continue;
      }
      line = `${ALERTS[alert[1]!]} ${alert[2]}`;
    } else if (pendingAlert && line.trim()) {
      line = `${pendingAlert} ${line.trim()}`;
      pendingAlert = undefined;
    }
    line = line.replace(/^#{3,6}\s+(.*?)\s*#*\s*$/, (_m, heading: string) => (/[.?!:]$/.test(heading) ? heading : `${heading}:`));
    out.push(inline(line));
  }
  if (fence) {
    const code = fence.lines.join('\n').trim();
    if (code && code.length <= maxCode) out.push(code);
  }
  return decodeEntities(stripHtml(out.join('\n')))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trimEnd())
    .filter((l, i, all) => !(l.trim() === '' && (all[i - 1] ?? '').trim() === ''))
    .join('\n')
    .replace(/^\s*:\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits Markdown at `#` and `##` headings (outside code fences) into cleaned sections; empty sections are dropped. */
export function markdownSections(markdown: string, opts: { maxCodeChars?: number } = {}): MarkdownSection[] {
  const sections: { heading: string; level: number; lines: string[] }[] = [{ heading: '', level: 1, lines: [] }];
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      const level = heading[1]!.length;
      const text = cleanMarkdown(heading[2]!).replace(/\s+/g, ' ').trim();
      // The first title names the document; later level-1 headings start sections like level-2 ones.
      if (level === 1 && !sections[0]!.heading && sections.length === 1) sections[0]!.heading = text;
      else sections.push({ heading: text, level: 2, lines: [] });
      continue;
    }
    sections[sections.length - 1]!.lines.push(line);
  }
  return sections
    .map((s) => ({ heading: s.heading, level: s.level, anchor: headingAnchor(s.heading), text: cleanMarkdown(s.lines.join('\n'), opts) }))
    .filter((s) => s.text.length > 0);
}
