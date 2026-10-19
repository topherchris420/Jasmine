import { EngineError } from '../errors.ts';
import { decodeEntities } from './xml.ts';

export interface ScrapeResult {
  url: string;
  sourceURL: string;
  statusCode: number;
  title: string;
  description: string;
  markdown: string;
  links: string[];
  contentType: string;
}

export interface ScrapeOptions {
  fetch: typeof fetch;
  signal: AbortSignal;
  onlyMainContent?: boolean;
  includeHtml?: boolean;
  userAgent?: string;
  maxBytes?: number;
}

const UA = 'JasmineBot/1.0 (+local workflow engine)';

export async function scrapePage(url: string, o: ScrapeOptions): Promise<ScrapeResult & { html?: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new EngineError('BAD_PAYLOAD', `Not a valid URL: ${url.slice(0, 200)}`);
  }
  if (!/^https?:$/.test(target.protocol)) throw new EngineError('BAD_PAYLOAD', 'Only http(s) pages can be scraped');
  let res: Response;
  try {
    res = await o.fetch(target.href, { signal: o.signal, redirect: 'follow', headers: { 'user-agent': o.userAgent ?? UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
  } catch (e) {
    if (o.signal.aborted) throw o.signal.reason;
    // Already classified, such as an address the egress guard refused: not a network failure to retry.
    if (e instanceof EngineError) throw e;
    throw new EngineError('NETWORK', `Could not reach ${target.host}: ${(e as Error).message}`, { retryable: true, cause: e });
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const buf = new Uint8Array(await res.arrayBuffer());
  const limit = o.maxBytes ?? 5_000_000;
  const body = Buffer.from(buf.subarray(0, limit)).toString('utf8');
  const finalUrl = res.url || target.href;
  if (!contentType.includes('html') && !/^\s*</.test(body)) {
    return { url: finalUrl, sourceURL: url, statusCode: res.status, title: '', description: '', markdown: body, links: [], contentType };
  }
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? '');
  const description = decodeEntities(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(body)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(body)?.[1] ?? '');
  const links = extractLinks(body, finalUrl);
  const main = o.onlyMainContent !== false ? mainContent(body) : body;
  return {
    url: finalUrl, sourceURL: url, statusCode: res.status, title, description, markdown: htmlToMarkdown(main, finalUrl), links, contentType,
    ...(o.includeHtml ? { html: body } : {}),
  };
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]!), base);
      if (/^https?:$/.test(u.protocol)) out.add(u.href);
    } catch {
      /* skip malformed */
    }
  }
  return [...out];
}

/** Prefers <main>/<article>/role=main content; otherwise the body without navigation chrome. */
function mainContent(html: string): string {
  const pick = (re: RegExp) => re.exec(html)?.[1];
  return pick(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
    ?? pick(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    ?? pick(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i)
    ?? (pick(/<body\b[^>]*>([\s\S]*?)<\/body>/i) ?? html).replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '');
}

export function htmlToMarkdown(html: string, base = 'http://localhost/'): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '');
  const abs = (href: string) => {
    try {
      return new URL(decodeEntities(href), base).href;
    } catch {
      return href;
    }
  };
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${inline(t)}\n\n`);
  s = s.replace(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/gi, (_, alt: string) => `![${alt}]`);
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
    const label = inline(text);
    return label ? (href.startsWith('#') || href.startsWith('javascript:') ? label : `[${label}](${abs(href)})`) : '';
  });
  s = s
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => `**${t.trim()}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => `*${t.trim()}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${t.trim()}\``)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|blockquote|header|main|figure)>/gi, '\n\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n[ \t]+(?=- )/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/* ---------------- crawler ---------------- */

export interface CrawlOptions extends ScrapeOptions {
  limit?: number;
  maxDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  allowExternal?: boolean;
  respectRobots?: boolean;
  concurrency?: number;
}

export async function crawl(start: string, o: CrawlOptions): Promise<(ScrapeResult & { depth: number })[]> {
  const root = new URL(start);
  const limit = Math.min(Math.max(o.limit ?? 10, 1), 500);
  const maxDepth = Math.min(Math.max(o.maxDepth ?? 2, 0), 10);
  const robots = o.respectRobots === false ? undefined : await robotsRules(root, o);
  const matches = (patterns: string[] | undefined, path: string) => (patterns ?? []).some((p) => new RegExp(p.startsWith('^') ? p : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).test(path));
  const seen = new Set<string>([normalize(root.href)]);
  const queue: { url: string; depth: number }[] = [{ url: root.href, depth: 0 }];
  const out: (ScrapeResult & { depth: number })[] = [];
  const workers = Math.min(Math.max(o.concurrency ?? 3, 1), 8);
  const next = async (): Promise<void> => {
    while (queue.length && out.length < limit && !o.signal.aborted) {
      const item = queue.shift()!;
      let page: ScrapeResult;
      try {
        page = await scrapePage(item.url, o);
      } catch (e) {
        if (o.signal.aborted) throw o.signal.reason;
        if (item.depth === 0) throw e;
        continue;
      }
      if (out.length >= limit) break;
      // Error pages are not content; the start page still reports its failure to the caller.
      if (page.statusCode >= 400) {
        if (item.depth === 0) throw new EngineError('UPSTREAM_HTTP', `${root.host} returned ${page.statusCode}`, { retryable: page.statusCode >= 500 });
        continue;
      }
      out.push({ ...page, depth: item.depth });
      if (item.depth >= maxDepth) continue;
      for (const link of page.links) {
        const u = new URL(link);
        const key = normalize(u.href);
        if (seen.has(key)) continue;
        if (!o.allowExternal && u.host !== root.host) continue;
        if (robots && !robots(u.pathname)) continue;
        if (o.includePaths?.length && !matches(o.includePaths, u.pathname)) continue;
        if (matches(o.excludePaths, u.pathname)) continue;
        if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|zip|gz|mp4|mp3|woff2?)$/i.test(u.pathname)) continue;
        seen.add(key);
        queue.push({ url: u.href, depth: item.depth + 1 });
      }
    }
  };
  // Seed with the start page, then fan out.
  await next();
  if (queue.length && out.length < limit) await Promise.all(Array.from({ length: workers }, next));
  o.signal.throwIfAborted();
  return out.slice(0, limit);
}

function normalize(href: string): string {
  const u = new URL(href);
  u.hash = '';
  return u.href.replace(/\/$/, '');
}

async function robotsRules(root: URL, o: ScrapeOptions): Promise<((path: string) => boolean) | undefined> {
  try {
    const res = await o.fetch(new URL('/robots.txt', root).href, { signal: AbortSignal.any([o.signal, AbortSignal.timeout(5000)]), headers: { 'user-agent': o.userAgent ?? UA } });
    if (!res.ok) return undefined;
    const text = await res.text();
    const disallow: string[] = [];
    const allow: string[] = [];
    let applies = false;
    for (const line of text.split('\n')) {
      const [k, ...rest] = line.split('#')[0]!.split(':');
      const key = k?.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') applies = value === '*' || /jasmine/i.test(value);
      else if (applies && key === 'disallow' && value) disallow.push(value);
      else if (applies && key === 'allow' && value) allow.push(value);
    }
    return (path) => allow.some((a) => path.startsWith(a)) || !disallow.some((d) => path.startsWith(d));
  } catch {
    return undefined;
  }
}
