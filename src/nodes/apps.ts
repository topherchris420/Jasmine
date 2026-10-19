import { mysqlParameters } from '../integrations/sql-parameters.ts';
import { queryDatabase } from '../integrations/sql.ts';
import { connectedHandlers } from './connected.ts';
import { EngineError } from '../errors.ts';
import type { FlowNode } from '../flow/schema.ts';
import { resolveValue } from '../flow/template.ts';
import { crawl, scrapePage } from '../integrations/web.ts';
import { sendMail } from '../integrations/smtp.ts';
import { s3Copy, s3Delete, s3Get, s3ListPages, s3Presign, s3Put, type S3Config } from '../integrations/s3.ts';
import { xmlToJson } from '../integrations/xml.ts';
import type { WhereClause } from '../integrations/tables.ts';
import { mcpBindings, runChatNode, thinkingField } from './ai.ts';
import { bool, f, jsonField, jsonish, num, opts, required, str, val } from './common.ts';
import type { FieldSpec, NodeContext, NodeHandler, NodeSpec } from './types.ts';

/* ---------------- shared ---------------- */

/** Resolves the node's credential for an integration (by id or name; or the only one configured). */
export function credentialFor(ctx: NodeContext, integration: string): Record<string, string> {
  const raw = ctx.values['credentials'] ?? ctx.values['credential'];
  let ref: string | undefined;
  if (typeof raw === 'string' && raw.trim()) ref = str(val(ctx, ctx.values['credentials'] !== undefined ? 'credentials' : 'credential'));
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    ref = str(o['credentialId'] ?? o['id'] ?? o['name'] ?? o['credential_name']) || undefined;
  }
  const found = ctx.services.credentials?.resolve(ref, integration) ?? (ref ? ctx.services.credentials?.resolve(ref) : undefined);
  if (!found) throw new EngineError('BAD_PAYLOAD', `No ${integration} credential${ref ? ` named "${ref}"` : ''} is configured; add one under Integrations`);
  return found;
}

/**
 * Endpoints whose host comes from a credential (a local SearXNG, n8n or MinIO, a webhook URL) were set by
 * an admin, so they skip the flow egress guard. Flow data only fills in their paths and bodies.
 */
const configuredFetch = (ctx: NodeContext) => ctx.services.configuredFetch ?? ctx.services.fetch;

async function http(ctx: NodeContext, service: string, url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await configuredFetch(ctx)(url, { ...init, signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    throw new EngineError('NETWORK', `${service} unreachable: ${(e as Error).message}`, { retryable: true });
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const detail = typeof body === 'object' && body ? str((body as Record<string, unknown>)['message'] ?? (body as Record<string, unknown>)['error'] ?? (body as Record<string, unknown>)['description']) : text;
    throw new EngineError(res.status === 429 ? 'RATE_LIMITED' : res.status === 401 || res.status === 403 ? 'FORBIDDEN' : 'UPSTREAM_HTTP', `${service} returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, {
      retryable: res.status === 429 || res.status >= 500, details: { status: res.status },
    });
  }
  return body;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface AppOptions {
  type: string;
  label: string;
  description: string;
  integration?: string;
  icon?: string;
  fields: FieldSpec[];
  outputs: NodeSpec['outputs'];
  defaults: Record<string, unknown>;
  credentialFields?: NodeSpec['credentialFields'];
  sideEffect?: (node: FlowNode) => boolean;
  required?: string[];
  run: NodeHandler['run'];
  category?: NodeSpec['category'];
  hidden?: boolean;
}

function app(o: AppOptions): NodeHandler {
  return {
    type: o.type,
    kind: 'action',
    spec: {
      label: o.label, category: o.category ?? 'app', description: o.description, icon: o.icon ?? o.integration ?? 'app',
      fields: o.integration && o.credentialFields ? [f.credential(o.integration), ...o.fields] : o.fields,
      outputs: o.outputs, defaults: () => ({ nodeName: o.label, ...structuredClone(o.defaults) }),
      ...(o.integration ? { integration: o.integration } : {}), ...(o.credentialFields ? { credentialFields: o.credentialFields } : {}),
      ...(o.hidden ? { hidden: true } : {}),
    },
    ...(o.sideEffect ? { sideEffect: o.sideEffect, idempotent: () => false } : {}),
    validate: (node) => required(node, ...(o.required ?? [])),
    run: o.run,
  };
}

const list = (v: unknown): string[] => {
  const j = jsonish(v);
  return (Array.isArray(j) ? j : typeof j === 'string' ? j.split(',') : j === undefined || j === null ? [] : [j]).map((x) => str(x).trim()).filter(Boolean);
};

/* ---------------- web ---------------- */

const scraper = app({
  type: 'scraperNode', label: 'Web Scraper', icon: 'globe', description: 'Fetch a web page and convert its main content to Markdown. Runs locally; no API key.',
  fields: [f.text('url', 'URL', { required: true }), f.bool('onlyMainContent', 'Main content only'), f.bool('includeHtml', 'Include raw HTML', { advanced: true })],
  outputs: [{ path: 'markdown', type: 'string' }, { path: 'title', type: 'string' }, { path: 'links', type: 'string[]' }, { path: 'statusCode', type: 'number' }],
  defaults: { url: '', onlyMainContent: true }, required: ['url'],
  async run(ctx) {
    const page = await scrapePage(str(val(ctx, 'url')), { fetch: ctx.services.fetch, signal: ctx.signal, onlyMainContent: bool(ctx.values['onlyMainContent'], true), includeHtml: bool(ctx.values['includeHtml']) });
    return { output: { ...page, scrapeId: ctx.idempotencyKey, metadata: { title: page.title, description: page.description, sourceURL: page.sourceURL, statusCode: page.statusCode } } };
  },
});

const crawlFields = [
  f.text('url', 'Start URL', { required: true }), f.num('crawlLimit', 'Max pages'), f.num('crawlDepth', 'Max depth'),
  { key: 'includePaths', label: 'Only paths matching', type: 'stringList' as const, advanced: true }, { key: 'excludePaths', label: 'Skip paths matching', type: 'stringList' as const, advanced: true },
  f.bool('allowExternalLinks', 'Follow external links', { advanced: true }), f.bool('ignoreRobots', 'Ignore robots.txt', { advanced: true }),
];

async function doCrawl(ctx: NodeContext, url: string) {
  return crawl(url, {
    fetch: ctx.services.fetch, signal: ctx.signal, limit: Math.trunc(num(val(ctx, 'crawlLimit'), 10)), maxDepth: Math.trunc(num(val(ctx, 'crawlDepth'), 2)),
    includePaths: list(ctx.values['includePaths']), excludePaths: list(ctx.values['excludePaths']),
    allowExternal: bool(ctx.values['allowExternalLinks']), respectRobots: !bool(ctx.values['ignoreRobots']),
    onlyMainContent: bool(ctx.values['onlyMainContent'], true),
  });
}

const pageDoc = (p: Awaited<ReturnType<typeof doCrawl>>[number]) => ({
  url: p.url, markdown: p.markdown, content: p.markdown, metadata: { title: p.title, description: p.description, sourceURL: p.url, statusCode: p.statusCode, depth: p.depth },
});

const crawler = app({
  type: 'crawlerNode', label: 'Web Crawler', icon: 'globe', description: 'Crawl a site (same domain by default, robots.txt respected) and return every page as Markdown.',
  fields: crawlFields, outputs: [{ path: 'data', type: 'array', description: '[{ url, markdown, metadata }]' }, { path: 'data[:].markdown', type: 'string[]' }],
  defaults: { url: '', crawlLimit: 10, crawlDepth: 2 }, required: ['url'],
  async run(ctx) {
    const pages = await doCrawl(ctx, str(val(ctx, 'url')));
    return { output: { success: true, status: 'completed', total: pages.length, data: pages.map(pageDoc) } };
  },
});

const firecrawl = app({
  type: 'firecrawlNode', label: 'Scrape & Crawl', icon: 'globe', description: 'Firecrawl-compatible scraping with a local engine: single page, batch of URLs, site crawl, or site map.',
  fields: [f.select('mode', 'Mode', [['syncSingleScrape', 'Scrape one page'], ['syncBatchScrape', 'Scrape a list of URLs'], ['sync', 'Crawl a site'], ['map', 'Map site links']]),
    { ...f.text('url', 'URL'), showIf: { key: 'mode', equals: ['syncSingleScrape', 'sync', 'map'] } }, { key: 'urls', label: 'URLs', type: 'stringList', showIf: { key: 'mode', equals: ['syncBatchScrape'] } },
    ...crawlFields.slice(1).map((x) => ({ ...x, showIf: { key: 'mode', equals: ['sync', 'map'] } })), f.bool('onlyMainContent', 'Main content only')],
  outputs: [{ path: 'markdown', type: 'string' }, { path: 'data', type: 'array' }, { path: 'links', type: 'string[]' }],
  defaults: { mode: 'syncSingleScrape', url: '', urls: [], crawlLimit: 10, crawlDepth: 2, onlyMainContent: true },
  async run(ctx) {
    const mode = str(ctx.values['mode']) || 'syncSingleScrape';
    const scrapeOne = (u: string) => scrapePage(u, { fetch: ctx.services.fetch, signal: ctx.signal, onlyMainContent: bool(ctx.values['onlyMainContent'], true) });
    if (mode === 'syncBatchScrape') {
      const urls = list(val(ctx, 'urls', []));
      const data = [];
      for (const u of urls.slice(0, 100)) data.push(pageDoc({ ...await scrapeOne(u), depth: 0 }));
      return { output: { success: true, data } };
    }
    if (mode === 'sync' || mode === 'async' || mode === 'map') {
      const pages = await doCrawl(ctx, str(val(ctx, 'url')));
      if (mode === 'map') return { output: { success: true, links: [...new Set(pages.flatMap((p) => [p.url, ...p.links]))] } };
      return { output: { success: true, status: 'completed', data: pages.map(pageDoc) } };
    }
    const page = await scrapeOne(str(val(ctx, 'url')));
    return { output: { success: true, markdown: page.markdown, data: [pageDoc({ ...page, depth: 0 })], metadata: { title: page.title, sourceURL: page.url, statusCode: page.statusCode } } };
  },
});

const webSearch = app({
  type: 'webSearchNode', label: 'Web Search', integration: 'searxng', icon: 'search',
  description: 'Search the web through your self-hosted SearXNG instance (no third-party API key).',
  credentialFields: [{ key: 'baseUrl', label: 'SearXNG URL', placeholder: 'http://127.0.0.1:8888' }, { key: 'token', label: 'Bearer token (optional)', secret: true }],
  fields: [f.text('query', 'Query', { required: true }), f.num('results', 'Results'), f.select('type', 'Type', [['general', 'Web'], ['news', 'News'], ['images', 'Images']]), f.text('language', 'Language', { advanced: true }), f.select('dateRange', 'Date range', ['', 'day', 'week', 'month', 'year'], { advanced: true }), f.num('page', 'Page', { advanced: true })],
  outputs: [{ path: 'output.organic', type: 'array', description: '[{ title, link, snippet }]' }, { path: 'organic', type: 'array' }],
  defaults: { query: '', results: 5, type: 'general' }, required: ['query'],
  async run(ctx) {
    const cred = credentialFor(ctx, 'searxng');
    const url = new URL('/search', cred['baseUrl'] || 'http://127.0.0.1:8888');
    url.searchParams.set('q', str(val(ctx, 'query')));
    url.searchParams.set('format', 'json');
    const type = str(ctx.values['type']) || 'general';
    url.searchParams.set('categories', type === 'images' ? 'images' : type === 'news' ? 'news' : 'general');
    if (str(ctx.values['language'])) url.searchParams.set('language', str(ctx.values['language']));
    if (str(ctx.values['dateRange'])) url.searchParams.set('time_range', str(ctx.values['dateRange']));
    url.searchParams.set('pageno', String(Math.max(1, Math.trunc(num(ctx.values['page'], 1)))));
    const body = await http(ctx, 'SearXNG', url.href, { headers: { accept: 'application/json', ...(cred['token'] ? { authorization: `Bearer ${cred['token']}` } : {}) } }) as { results?: Record<string, unknown>[] };
    const organic = (body.results ?? []).slice(0, Math.max(1, Math.trunc(num(val(ctx, 'results'), 5)))).map((r, i) => ({
      position: i + 1, title: str(r['title']), link: str(r['url']), snippet: str(r['content']), ...(r['publishedDate'] ? { date: str(r['publishedDate']) } : {}), ...(r['img_src'] ? { imageUrl: str(r['img_src']) } : {}),
    }));
    return { output: { output: { organic, ...(type === 'news' ? { news: organic } : {}) }, organic } };
  },
});

const rss = app({
  type: 'rssNode', label: 'RSS Feed', icon: 'rss', description: 'Read the latest items from an RSS or Atom feed.',
  fields: [f.text('url', 'Feed URL', { required: true }), f.num('limit', 'Items')], outputs: [{ path: 'items', type: 'array', description: '[{ title, link, description, published }]' }, { path: 'title', type: 'string' }],
  defaults: { url: '', limit: 10 }, required: ['url'],
  async run(ctx) {
    const res = await ctx.services.fetch(str(val(ctx, 'url')), { signal: ctx.signal, headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' } });
    if (!res.ok) throw new EngineError('UPSTREAM_HTTP', `Feed returned ${res.status}`, { retryable: res.status >= 500 });
    const doc = xmlToJson(await res.text()) as Record<string, any>;
    const channel = doc['rss']?.['channel'] ?? doc['rdf:RDF'] ?? {};
    const atom = doc['feed'];
    const raw = atom ? atom['entry'] : channel['item'] ?? doc['rdf:RDF']?.['item'];
    const items = (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, Math.max(1, Math.trunc(num(val(ctx, 'limit'), 10)))).map((it: Record<string, any>) => ({
      title: text(it['title']), link: atom ? str((Array.isArray(it['link']) ? it['link'][0] : it['link'])?.['@href'] ?? '') : text(it['link']),
      description: text(it['description'] ?? it['summary'] ?? it['content'] ?? it['content:encoded']),
      published: text(it['pubDate'] ?? it['published'] ?? it['updated'] ?? it['dc:date']), author: text(it['author']?.['name'] ?? it['author'] ?? it['dc:creator']),
      id: text(it['guid'] ?? it['id'] ?? ''),
    }));
    return { output: { title: text(atom ? atom['title'] : channel['title']), items } };
  },
});

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && '#text' in (v as object)) return str((v as Record<string, unknown>)['#text']);
  return str(v);
}

/* ---------------- messaging ---------------- */

const slack = app({
  type: 'slackNode', label: 'Slack', integration: 'slack', icon: 'slack', description: 'Post a message to Slack with a bot token or an incoming webhook.',
  credentialFields: [{ key: 'botToken', label: 'Bot token (xoxb-…)', secret: true }, { key: 'webhookUrl', label: 'Incoming webhook URL', secret: true }],
  fields: [f.select('action', 'Action', [['postMessage', 'Post message']]), f.text('channelName', 'Channel', { placeholder: '#general (bot token only)' }), f.area('text', 'Message', { required: true })],
  outputs: [{ path: 'ok', type: 'boolean' }, { path: 'ts', type: 'string' }, { path: 'channel', type: 'string' }],
  defaults: { action: 'postMessage', channelName: '', text: '' }, required: ['text'], sideEffect: () => true,
  async run(ctx) {
    const cred = credentialFor(ctx, 'slack');
    const message = str(val(ctx, 'text'));
    if (cred['botToken']) {
      const body = await http(ctx, 'Slack', 'https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${cred['botToken']}` }, body: JSON.stringify({ channel: str(val(ctx, 'channelName')).replace(/^#/, ''), text: message }) }) as Record<string, unknown>;
      if (body['ok'] !== true) throw new EngineError('UPSTREAM_HTTP', `Slack: ${str(body['error'])}`);
      return { output: { ok: true, ts: body['ts'], channel: body['channel'] } };
    }
    if (!cred['webhookUrl']) throw new EngineError('BAD_PAYLOAD', 'Slack credential needs a bot token or webhook URL');
    await http(ctx, 'Slack', cred['webhookUrl'], json({ text: message }));
    return { output: { ok: true } };
  },
});

const teams = app({
  type: 'teamsNode', label: 'Microsoft Teams', integration: 'teams', icon: 'teams', description: 'Post a message to a Teams channel through an incoming webhook or workflow URL.',
  credentialFields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
  fields: [f.area('message', 'Message', { required: true })], outputs: [{ path: 'ok', type: 'boolean' }],
  defaults: { message: '' }, required: ['message'], sideEffect: () => true,
  async run(ctx) {
    await http(ctx, 'Teams', credentialFor(ctx, 'teams')['webhookUrl'] ?? '', json({ text: str(val(ctx, 'message')) }));
    return { output: { ok: true } };
  },
});

const discord = app({
  type: 'discordNode', label: 'Discord', integration: 'discord', icon: 'discord', description: 'Post a message to a Discord channel webhook.',
  credentialFields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
  fields: [f.area('content', 'Message', { required: true }), f.text('username', 'Display name', { advanced: true })], outputs: [{ path: 'ok', type: 'boolean' }],
  defaults: { content: '' }, required: ['content'], sideEffect: () => true,
  async run(ctx) {
    const username = str(val(ctx, 'username', ''));
    await http(ctx, 'Discord', credentialFor(ctx, 'discord')['webhookUrl'] ?? '', json({ content: str(val(ctx, 'content')).slice(0, 2000), ...(username ? { username } : {}) }));
    return { output: { ok: true } };
  },
});

const telegram = app({
  type: 'telegramNode', label: 'Telegram', integration: 'telegram', icon: 'telegram', description: 'Send a Telegram message with your bot.',
  credentialFields: [{ key: 'botToken', label: 'Bot token', secret: true }],
  fields: [f.text('chatId', 'Chat id', { required: true }), f.area('text', 'Message', { required: true }), f.select('parseMode', 'Formatting', ['', 'Markdown', 'HTML'], { advanced: true })],
  outputs: [{ path: 'messageId', type: 'number' }], defaults: { chatId: '', text: '' }, required: ['chatId', 'text'], sideEffect: () => true,
  async run(ctx) {
    const token = credentialFor(ctx, 'telegram')['botToken'] ?? '';
    const parseMode = str(ctx.values['parseMode']);
    const body = await http(ctx, 'Telegram', `https://api.telegram.org/bot${token}/sendMessage`, json({ chat_id: str(val(ctx, 'chatId')), text: str(val(ctx, 'text')), ...(parseMode ? { parse_mode: parseMode } : {}) })) as { result?: { message_id?: number } };
    return { output: { ok: true, messageId: body.result?.message_id } };
  },
});

function mailHandler(type: string, label: string, keys: { to: string; isHtml: string }): NodeHandler {
  return app({
    type, label, integration: 'smtp', icon: 'mail', description: 'Send email through any SMTP server (Gmail with an app password, Mailpit, Postfix…).',
    credentialFields: [{ key: 'host', label: 'SMTP host' }, { key: 'port', label: 'Port', placeholder: '587' }, { key: 'secure', label: 'Implicit TLS (true for port 465)' }, { key: 'username', label: 'Username' }, { key: 'password', label: 'Password', secret: true }, { key: 'from', label: 'From address' }],
    fields: [f.text(keys.to, 'To', { required: true, help: 'Comma-separated' }), f.text('cc', 'Cc', { advanced: true }), f.text('bcc', 'Bcc', { advanced: true }), f.text('subject', 'Subject', { required: true }), f.area('body', 'Body', { required: true }), f.bool(keys.isHtml, 'HTML body')],
    outputs: [{ path: 'messageId', type: 'string' }, { path: 'accepted', type: 'string[]' }],
    defaults: { [keys.to]: '', subject: '', body: '', [keys.isHtml]: false }, required: [keys.to, 'subject'], sideEffect: () => true,
    async run(ctx) {
      const c = credentialFor(ctx, 'smtp');
      const port = Math.trunc(num(c['port'], 587));
      const result = await sendMail({
        host: c['host'] ?? '', port, secure: bool(c['secure'], port === 465), from: c['from'] || c['username'] || '',
        ...(c['username'] ? { username: c['username'] } : {}), ...(c['password'] ? { password: c['password'] } : {}), allowInsecureTls: bool(c['allowInsecureTls']),
      }, {
        to: list(val(ctx, keys.to)), cc: list(val(ctx, 'cc', '')), bcc: list(val(ctx, 'bcc', '')),
        subject: str(val(ctx, 'subject')), body: str(val(ctx, 'body', '')), html: bool(ctx.values[keys.isHtml]),
      }, ctx.signal);
      return { output: { success: true, ...result } };
    },
  });
}



/* ---------------- productivity ---------------- */

const notion = app({
  type: 'notionNode', label: 'Notion', integration: 'notion', icon: 'notion', description: 'Create pages, append content, query databases or search a Notion workspace.',
  credentialFields: [{ key: 'token', label: 'Integration token', secret: true }],
  fields: [
    f.select('action', 'Action', [['NOTION_CREATE_NOTION_PAGE', 'Create page'], ['NOTION_APPEND_BLOCK', 'Append text to page'], ['NOTION_QUERY_DATABASE', 'Query database'], ['NOTION_SEARCH', 'Search']]),
    f.text('databaseId', 'Database id', { showIf: { key: 'action', equals: ['NOTION_CREATE_NOTION_PAGE', 'NOTION_QUERY_DATABASE'] } }),
    f.text('pageId', 'Page id', { showIf: { key: 'action', equals: ['NOTION_CREATE_NOTION_PAGE', 'NOTION_APPEND_BLOCK'] }, help: 'Parent page (create) or target page (append)' }),
    f.text('title', 'Title', { showIf: { key: 'action', equals: ['NOTION_CREATE_NOTION_PAGE'] } }),
    f.area('content', 'Content', { showIf: { key: 'action', equals: ['NOTION_CREATE_NOTION_PAGE', 'NOTION_APPEND_BLOCK'] } }),
    f.json('properties', 'Properties', { advanced: true, showIf: { key: 'action', equals: ['NOTION_CREATE_NOTION_PAGE'] } }),
    f.json('filter', 'Filter', { advanced: true, showIf: { key: 'action', equals: ['NOTION_QUERY_DATABASE'] } }),
    f.text('query', 'Query', { showIf: { key: 'action', equals: ['NOTION_SEARCH'] } }),
  ],
  outputs: [{ path: 'id', type: 'string' }, { path: 'url', type: 'string' }, { path: 'results', type: 'array' }],
  defaults: { action: 'NOTION_CREATE_NOTION_PAGE', title: '', content: '' }, sideEffect: (n) => !['NOTION_QUERY_DATABASE', 'NOTION_SEARCH'].includes(String(n.values['action'])),
  async run(ctx) {
    const token = credentialFor(ctx, 'notion')['token'] ?? '';
    const headers = { authorization: `Bearer ${token}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' };
    const action = str(ctx.values['action']) || 'NOTION_CREATE_NOTION_PAGE';
    const paragraphs = (t: string) => t.split(/\n{2,}/).filter((p) => p.trim()).slice(0, 100).map((p) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 2000) } }] } }));
    if (action === 'NOTION_SEARCH') {
      return { output: await http(ctx, 'Notion', 'https://api.notion.com/v1/search', { method: 'POST', headers, body: JSON.stringify({ query: str(val(ctx, 'query', '')) }) }) };
    }
    if (action === 'NOTION_QUERY_DATABASE') {
      const filter = jsonField(ctx, 'filter', undefined, false);
      return { output: await http(ctx, 'Notion', `https://api.notion.com/v1/databases/${str(val(ctx, 'databaseId'))}/query`, { method: 'POST', headers, body: JSON.stringify(filter ? { filter } : {}) }) };
    }
    if (action === 'NOTION_APPEND_BLOCK') {
      return { output: await http(ctx, 'Notion', `https://api.notion.com/v1/blocks/${str(val(ctx, 'pageId'))}/children`, { method: 'PATCH', headers, body: JSON.stringify({ children: paragraphs(str(val(ctx, 'content', ''))) }) }) };
    }
    const databaseId = str(val(ctx, 'databaseId', ''));
    const title = str(val(ctx, 'title', 'Untitled'));
    const extra = (jsonField(ctx, 'properties', {}, false) ?? {}) as Record<string, unknown>;
    const body = databaseId
      ? { parent: { database_id: databaseId }, properties: { Name: { title: [{ text: { content: title } }] }, ...extra } }
      : { parent: { page_id: str(val(ctx, 'pageId')) }, properties: { title: { title: [{ text: { content: title } }] } } };
    const page = await http(ctx, 'Notion', 'https://api.notion.com/v1/pages', { method: 'POST', headers, body: JSON.stringify({ ...body, children: paragraphs(str(val(ctx, 'content', ''))) }) });
    return { output: page };
  },
});

const airtable = app({
  type: 'airtableNode', label: 'Airtable', integration: 'airtable', icon: 'airtable', description: 'List, create, update or delete Airtable records.',
  credentialFields: [{ key: 'token', label: 'Personal access token', secret: true }],
  fields: [
    f.select('action', 'Action', [['list', 'List records'], ['create', 'Create record'], ['update', 'Update record'], ['delete', 'Delete record']]),
    f.text('baseId', 'Base id', { required: true }), f.text('tableIdOrName', 'Table', { required: true }),
    f.json('fields', 'Fields', { showIf: { key: 'action', equals: ['create', 'update'] } }), f.text('recordId', 'Record id', { showIf: { key: 'action', equals: ['update', 'delete'] } }),
    f.text('filterByFormula', 'Formula filter', { showIf: { key: 'action', equals: ['list'] }, advanced: true }), f.num('maxRecords', 'Max records', { showIf: { key: 'action', equals: ['list'] } }),
  ],
  outputs: [{ path: 'records', type: 'array' }, { path: 'id', type: 'string' }, { path: 'fields', type: 'object' }],
  defaults: { action: 'list', baseId: '', tableIdOrName: '', maxRecords: 20 }, required: ['baseId', 'tableIdOrName'], sideEffect: (n) => n.values['action'] !== 'list',
  async run(ctx) {
    const token = credentialFor(ctx, 'airtable')['token'] ?? '';
    const base = `https://api.airtable.com/v0/${encodeURIComponent(str(val(ctx, 'baseId')))}/${encodeURIComponent(str(val(ctx, 'tableIdOrName')))}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const action = str(ctx.values['action']) || 'list';
    if (action === 'list') {
      const url = new URL(base);
      url.searchParams.set('maxRecords', String(Math.trunc(num(val(ctx, 'maxRecords'), 20))));
      if (str(val(ctx, 'filterByFormula', ''))) url.searchParams.set('filterByFormula', str(val(ctx, 'filterByFormula')));
      return { output: await http(ctx, 'Airtable', url.href, { headers }) };
    }
    const recordId = str(val(ctx, 'recordId', ''));
    if (action === 'delete') return { output: await http(ctx, 'Airtable', `${base}/${encodeURIComponent(recordId)}`, { method: 'DELETE', headers }) };
    const fields = jsonField(ctx, 'fields', {});
    if (action === 'update') return { output: await http(ctx, 'Airtable', `${base}/${encodeURIComponent(recordId)}`, { method: 'PATCH', headers, body: JSON.stringify({ fields }) }) };
    return { output: await http(ctx, 'Airtable', base, { method: 'POST', headers, body: JSON.stringify({ fields }) }) };
  },
});

const github = app({
  type: 'githubNode', label: 'GitHub', integration: 'github', icon: 'github', description: 'Create or list issues, comment, or read files (GitHub or GitHub Enterprise / Gitea API).',
  credentialFields: [{ key: 'token', label: 'Personal access token', secret: true }, { key: 'baseUrl', label: 'API URL (optional)', placeholder: 'https://api.github.com' }],
  fields: [
    f.select('action', 'Action', [['createIssue', 'Create issue'], ['listIssues', 'List issues'], ['createComment', 'Comment on issue/PR'], ['getFile', 'Read file']]),
    f.text('owner', 'Owner', { required: true }), f.text('repo', 'Repository', { required: true }),
    f.text('title', 'Title', { showIf: { key: 'action', equals: ['createIssue'] } }), f.area('body', 'Body', { showIf: { key: 'action', equals: ['createIssue', 'createComment'] } }),
    { key: 'labels', label: 'Labels', type: 'stringList', showIf: { key: 'action', equals: ['createIssue'] } },
    f.text('issueNumber', 'Issue / PR number', { showIf: { key: 'action', equals: ['createComment'] } }),
    f.select('state', 'State', ['open', 'closed', 'all'], { showIf: { key: 'action', equals: ['listIssues'] } }),
    f.text('path', 'File path', { showIf: { key: 'action', equals: ['getFile'] } }), f.text('ref', 'Branch / ref', { showIf: { key: 'action', equals: ['getFile'] }, advanced: true }),
  ],
  outputs: [{ path: 'number', type: 'number' }, { path: 'html_url', type: 'string' }, { path: 'content', type: 'string' }, { path: 'issues', type: 'array' }],
  defaults: { action: 'createIssue', owner: '', repo: '', title: '', body: '' }, required: ['owner', 'repo'], sideEffect: (n) => ['createIssue', 'createComment'].includes(String(n.values['action'])),
  async run(ctx) {
    const cred = credentialFor(ctx, 'github');
    const api = (cred['baseUrl'] || 'https://api.github.com').replace(/\/+$/, '');
    const repo = `${api}/repos/${encodeURIComponent(str(val(ctx, 'owner')))}/${encodeURIComponent(str(val(ctx, 'repo')))}`;
    const headers = { authorization: `Bearer ${cred['token'] ?? ''}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'jasmine' };
    const action = str(ctx.values['action']) || 'createIssue';
    if (action === 'listIssues') {
      const issues = await http(ctx, 'GitHub', `${repo}/issues?state=${encodeURIComponent(str(ctx.values['state']) || 'open')}&per_page=50`, { headers });
      return { output: { issues } };
    }
    if (action === 'createComment') {
      return { output: await http(ctx, 'GitHub', `${repo}/issues/${encodeURIComponent(str(val(ctx, 'issueNumber')))}/comments`, { method: 'POST', headers, body: JSON.stringify({ body: str(val(ctx, 'body')) }) }) };
    }
    if (action === 'getFile') {
      const ref = str(val(ctx, 'ref', ''));
      const file = await http(ctx, 'GitHub', `${repo}/contents/${str(val(ctx, 'path')).split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, { headers }) as Record<string, unknown>;
      const content = typeof file['content'] === 'string' ? Buffer.from(file['content'], 'base64').toString('utf8') : '';
      return { output: { ...file, content } };
    }
    return { output: await http(ctx, 'GitHub', `${repo}/issues`, { method: 'POST', headers, body: JSON.stringify({ title: str(val(ctx, 'title')), body: str(val(ctx, 'body', '')), labels: list(val(ctx, 'labels', [])) }) }) };
  },
});

const twilio = app({
  type: 'twilioNode', label: 'Twilio SMS', integration: 'twilio', icon: 'sms', description: 'Send an SMS or WhatsApp message with Twilio.',
  credentialFields: [{ key: 'accountSid', label: 'Account SID' }, { key: 'authToken', label: 'Auth token', secret: true }, { key: 'from', label: 'From number' }],
  fields: [f.select('action', 'Channel', [['sendSms', 'SMS'], ['sendWhatsapp', 'WhatsApp']]), f.text('to', 'To', { required: true }), f.area('body', 'Message', { required: true })],
  outputs: [{ path: 'sid', type: 'string' }, { path: 'status', type: 'string' }], defaults: { action: 'sendSms', to: '', body: '' }, required: ['to', 'body'], sideEffect: () => true,
  async run(ctx) {
    const c = credentialFor(ctx, 'twilio');
    const wa = str(ctx.values['action']) === 'sendWhatsapp';
    const form = new URLSearchParams({ To: `${wa ? 'whatsapp:' : ''}${str(val(ctx, 'to'))}`, From: `${wa ? 'whatsapp:' : ''}${c['from'] ?? ''}`, Body: str(val(ctx, 'body')) });
    const res = await http(ctx, 'Twilio', `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c['accountSid'] ?? '')}/Messages.json`, {
      method: 'POST', body: form, headers: { authorization: `Basic ${Buffer.from(`${c['accountSid']}:${c['authToken']}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    }) as Record<string, unknown>;
    return { output: { sid: res['sid'], status: res['status'] } };
  },
});

const n8n = app({
  type: 'n8nNode', label: 'n8n Workflow', integration: 'n8n', icon: 'flow', description: 'Trigger a self-hosted n8n workflow through its webhook and use the reply.',
  credentialFields: [{ key: 'baseUrl', label: 'n8n URL', placeholder: 'http://127.0.0.1:5678' }, { key: 'token', label: 'Header auth value (optional)', secret: true }],
  fields: [f.text('webhookPath', 'Webhook path', { required: true }), f.json('payload', 'Payload')],
  outputs: [{ path: '<field>', type: 'any', description: 'The workflow response' }], defaults: { webhookPath: '', payload: '{}' }, required: ['webhookPath'], sideEffect: () => true,
  async run(ctx) {
    const c = credentialFor(ctx, 'n8n');
    const url = `${(c['baseUrl'] || 'http://127.0.0.1:5678').replace(/\/+$/, '')}/webhook/${str(val(ctx, 'webhookPath')).replace(/^\/+/, '')}`;
    return { output: await http(ctx, 'n8n', url, { method: 'POST', headers: { 'content-type': 'application/json', ...(c['token'] ? { authorization: c['token'] } : {}) }, body: JSON.stringify(jsonField(ctx, 'payload', {})) }) };
  },
});

/* ---------------- data ---------------- */

/**
 * Turns `{{refs}}` inside SQL into bound parameters, so values from upstream nodes can never change
 * the statement. A quoted template ('{{x}}') becomes one parameter, quotes included.
 */
export function bindSqlTemplates(ctx: NodeContext, sql: string, params: unknown[], placeholder: (n: number) => string): { sql: string; params: unknown[] } {
  const out = [...params];
  const text = sql.replace(/'\{\{\s*([^{}]+?)\s*\}\}'|\{\{\s*([^{}]+?)\s*\}\}/g, (_m, quoted: string | undefined, bare: string | undefined) => {
    const value = resolveValue(`{{${quoted ?? bare}}}`, ctx.scope, opts(ctx));
    out.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null);
    return placeholder(out.length);
  });
  return { sql: text, params: out };
}

type PgModule = typeof import('pg');
let pgModule: Promise<PgModule> | undefined;

const postgres = app({
  type: 'postgresNode', label: 'PostgreSQL', integration: 'postgres', icon: 'database', description: 'Run SQL against PostgreSQL with bound parameters ($1, $2…).',
  credentialFields: [{ key: 'connectionString', label: 'Connection string', secret: true, placeholder: 'postgres://user:pass@127.0.0.1:5432/db' }, { key: 'ssl', label: 'Use TLS (true/false)' }],
  fields: [f.select('action', 'Action', [['runQuery', 'Run query']]), { key: 'query', label: 'SQL', type: 'code', required: true }, f.json('params', 'Parameters', { help: 'JSON array bound to $1, $2…; never splice user input into SQL.' })],
  outputs: [{ path: 'queryResult', type: 'array' }, { path: 'rowCount', type: 'number' }], defaults: { action: 'runQuery', query: 'SELECT now()', params: '[]' }, required: ['query'],
  sideEffect: (n) => !/^\s*(select|with|show|explain)\b/i.test(String(n.values['query'] ?? '')),
  async run(ctx) {
    const c = credentialFor(ctx, 'postgres');
    pgModule ??= import('pg');
    const pg = (await pgModule).default ?? (await pgModule);
    const client = new pg.Client({ connectionString: c['connectionString'], ...(bool(c['ssl']) ? { ssl: { rejectUnauthorized: !bool(c['allowInsecureTls']) } } : {}), statement_timeout: 60_000, connectionTimeoutMillis: 10_000 });
    const params = jsonField(ctx, 'params', []);
    const abort = () => void client.end().catch(() => {});
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      const bound = bindSqlTemplates(ctx, str(ctx.values['query']), Array.isArray(params) ? params : [], (n) => `$${n}`);
      const res = await client.query(bound.sql, bound.params);
      return { output: { queryResult: res.rows, rowCount: res.rowCount ?? res.rows.length, fields: res.fields.map((x) => x.name) } };
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new EngineError('UPSTREAM_HTTP', `PostgreSQL: ${(e as Error).message}`, { retryable: /ECONNREFUSED|timeout/i.test((e as Error).message) });
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      await client.end().catch(() => {});
    }
  },
});

const tables = app({
  type: 'tablesNode', label: 'Tables', icon: 'table', category: 'data', description: 'Read and write local data tables (create them under Context → Tables).',
  fields: [
    f.select('action', 'Action', [['select', 'Select rows'], ['insert', 'Insert rows'], ['update', 'Update rows'], ['delete', 'Delete rows'], ['query', 'SQL query (read-only)']]),
    f.text('tableName', 'Table', { showIf: { key: 'action', equals: ['select', 'insert', 'update', 'delete'] } }),
    { key: 'columns', label: 'Columns', type: 'stringList', showIf: { key: 'action', equals: ['select'] }, advanced: true },
    f.json('data', 'Row data', { showIf: { key: 'action', equals: ['insert', 'update'] }, help: 'An object, or a list of objects to insert' }),
    f.json('where', 'Where', { showIf: { key: 'action', equals: ['select', 'update', 'delete'] }, help: '{"conjunction":"AND","conditions":[{"column":"status","operator":"=","value":"open"}]}' }),
    f.json('orderBy', 'Order by', { showIf: { key: 'action', equals: ['select'] }, advanced: true }),
    f.num('limit', 'Limit', { showIf: { key: 'action', equals: ['select'] } }), f.num('offset', 'Offset', { showIf: { key: 'action', equals: ['select'] }, advanced: true }),
    { key: 'query', label: 'SQL', type: 'code', showIf: { key: 'action', equals: ['query'] } }, f.json('params', 'Parameters', { showIf: { key: 'action', equals: ['query'] } }),
  ],
  outputs: [{ path: 'rows', type: 'array' }, { path: 'count', type: 'number' }, { path: 'insertedCount', type: 'number' }, { path: 'updatedCount', type: 'number' }, { path: 'deletedCount', type: 'number' }],
  defaults: { action: 'select', tableName: '', where: '', limit: 50 }, sideEffect: (n) => ['insert', 'update', 'delete'].includes(String(n.values['action'])),
  async run(ctx) {
    const store = ctx.services.tables;
    if (!store) throw new EngineError('INTERNAL', 'Tables are not configured in this runtime');
    const action = str(ctx.values['action']) || 'select';
    const table = str(val(ctx, 'tableName', ''));
    const where = jsonField(ctx, 'where', undefined, false) as WhereClause | undefined;
    switch (action) {
      case 'insert': {
        const r = store.insert(table, jsonField(ctx, 'data', {}) as Record<string, unknown>);
        return { output: { ...r, message: `Inserted ${r.insertedCount} row(s)` } };
      }
      case 'update': {
        const r = store.update(table, jsonField(ctx, 'data', {}) as Record<string, unknown>, where);
        return { output: { ...r, message: `Updated ${r.updatedCount} row(s)` } };
      }
      case 'delete': {
        const r = store.delete(table, where);
        return { output: { ...r, message: `Deleted ${r.deletedCount} row(s)` } };
      }
      case 'query': {
        const bound = bindSqlTemplates(ctx, str(ctx.values['query']), (jsonField(ctx, 'params', []) ?? []) as unknown[], () => '?');
        const r = store.query(bound.sql, bound.params);
        return { output: { ...r, results: r.rows } };
      }
      default: {
        const orderBy = jsonField(ctx, 'orderBy', undefined, false);
        const r = store.select(table, {
          columns: list(ctx.values['columns']), ...(where ? { where } : {}), ...(Array.isArray(orderBy) ? { orderBy } : {}),
          limit: num(val(ctx, 'limit'), 50), offset: num(val(ctx, 'offset'), 0),
        });
        return { output: { ...r, results: r.rows } };
      }
    }
  },
});

const s3 = app({
  type: 's3Node', label: 'S3 Storage', integration: 's3', icon: 'bucket', description: 'Upload, download, list, delete or share files in S3-compatible storage (MinIO, Garage, AWS).',
  credentialFields: [{ key: 'endpoint', label: 'Endpoint', placeholder: 'http://127.0.0.1:9000' }, { key: 'region', label: 'Region', placeholder: 'us-east-1' }, { key: 'accessKeyId', label: 'Access key id' }, { key: 'secretAccessKey', label: 'Secret access key', secret: true }, { key: 'sessionToken', label: 'Temporary session token (optional)', secret: true }, { key: 'forcePathStyle', label: 'Path-style URLs (true for MinIO)' }],
  fields: [
    f.select('action', 'Action', [['upload', 'Upload'], ['download', 'Download'], ['list', 'List'], ['delete', 'Delete'], ['presign', 'Share link'], ['copy', 'Copy'], ['move', 'Move']]),
    f.text('bucket', 'Bucket', { required: true }), f.text('filePath', 'Key / path', { showIf: { key: 'action', equals: ['upload', 'download', 'delete', 'presign', 'copy', 'move'] } }),
    f.text('destinationBucket','Destination bucket',{showIf:{key:'action',equals:['copy','move']},help:'Defaults to the source bucket'}),f.text('destinationPath','Destination path',{showIf:{key:'action',equals:['copy','move']}}),
    f.area('content', 'Content', { showIf: { key: 'action', equals: ['upload'] } }), f.select('encoding', 'Content encoding', ['utf8', 'base64'], { showIf: { key: 'action', equals: ['upload', 'download'] }, advanced: true }),
    f.text('fileType', 'Content type', { showIf: { key: 'action', equals: ['upload'] }, advanced: true }), f.text('prefix', 'Prefix', { showIf: { key: 'action', equals: ['list'] } }),
    f.num('urlExpiry', 'Link lifetime (s)', { showIf: { key: 'action', equals: ['presign'] } }),
    f.text('continuationToken','Continuation token',{showIf:{key:'action',equals:['list']}}),f.num('maxKeys','Keys per page',{showIf:{key:'action',equals:['list']},help:'1–1000'}),f.num('maxPages','Maximum pages',{showIf:{key:'action',equals:['list']},help:'1–100; the default reads one page'}),
  ],
  outputs: [{ path: 'key', type: 'string' }, { path: 'content', type: 'string' }, { path: 'files', type: 'array' }, { path: 'url', type: 'string' },{path:'nextContinuationToken',type:'string'},{path:'isTruncated',type:'boolean'}],
  defaults: { action: 'upload', bucket: '', filePath: '', content: '', encoding: 'utf8', urlExpiry: 3600 }, required: ['bucket'],
  sideEffect: (n) => !['download','list','presign'].includes(String(n.values['action'])),
  async run(ctx) {
    const c = credentialFor(ctx, 's3');
    const config: S3Config = { endpoint: c['endpoint'] || 'https://s3.amazonaws.com', region: c['region'] || 'us-east-1', accessKeyId: c['accessKeyId'] ?? '', secretAccessKey: c['secretAccessKey'] ?? '',sessionToken:c['sessionToken'], forcePathStyle: c['forcePathStyle'] !== 'false' };
    const bucket = str(val(ctx, 'bucket'));
    const key = str(val(ctx, 'filePath', ''));
    const encoding = str(ctx.values['encoding']) === 'base64' ? 'base64' : 'utf8';
    const fetch = configuredFetch(ctx);
    switch (str(ctx.values['action']) || 'upload') {
      case 'download': {
        const r = await s3Get(config, fetch, bucket, key, ctx.signal);
        return { output: { key, contentType: r.contentType, size: r.bytes.byteLength, content: Buffer.from(r.bytes).toString(encoding) } };
      }
      case 'list': return { output: await s3ListPages(config, fetch, bucket, str(val(ctx, 'prefix', '')), ctx.signal,{maxKeys:num(val(ctx,'maxKeys'),1000),maxPages:num(val(ctx,'maxPages'),1),continuationToken:str(val(ctx,'continuationToken',''))}) };
      case 'delete': return { output: await s3Delete(config, fetch, bucket, key, ctx.signal) };
      case 'presign': return { output: { key, url: s3Presign(config, bucket, key, num(val(ctx, 'urlExpiry'), 3600)) } };
      case 'copy': case 'move': return {output:await s3Copy(config,fetch,bucket,key,str(val(ctx,'destinationBucket',bucket))||bucket,str(val(ctx,'destinationPath','')),ctx.signal,str(ctx.values['action'])==='move')};
      case 'upload':
      {
        const content = val(ctx, 'content', '');
        const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content), encoding);
        return { output: await s3Put(config, fetch, bucket, key, bytes, str(ctx.values['fileType']) || 'application/octet-stream', ctx.signal) };
      }
      default: throw new EngineError('BAD_PAYLOAD','Unknown S3 action');
    }
  },
});

/* ---------------- MCP ---------------- */

const mcp = app({
  type: 'mcpNode', label: 'MCP Agent', integration: 'mcp', icon: 'plug', category: 'ai',
  description: 'Let a local model use the tools of any Model Context Protocol server (Streamable HTTP).',
  credentialFields: [{ key: 'url', label: 'Server URL', placeholder: 'http://127.0.0.1:3001/mcp' }, { key: 'token', label: 'Bearer token (optional)', secret: true }, { key: 'headers', label: 'Extra headers (JSON, optional)' }],
  fields: [{ key: 'selectedTools', label: 'Only these tools', type: 'stringList', help: 'Empty = every tool the server offers' }, f.model(), { key: 'prompts', label: 'Prompts', type: 'prompts', required: true },
    { key: 'messages', label: 'Chat history', type: 'messages', advanced: true }, f.text('memories', 'Memories', { advanced: true }), thinkingField],
  outputs: [{ path: 'generatedResponse', type: 'string' }, { path: 'toolCalls', type: 'array' }],
  defaults: { selectedTools: [], prompts: [{ id: 'user', role: 'user', content: '{{triggerNode_1.output.question}}' }], messages: '[]', memories: '[]' },
  async run(ctx) {
    const raw = ctx.values['credentials'];
    const ref = typeof raw === 'string' ? str(val(ctx, 'credentials')) : raw && typeof raw === 'object' ? str((raw as Record<string, unknown>)['name'] ?? (raw as Record<string, unknown>)['credentialId']) : undefined;
    const bindings = await mcpBindings(ctx, ref || undefined, list(ctx.values['selectedTools']));
    return runChatNode(ctx, 'generatedResponse', bindings);
  },
});

/* ---------------- SQL integrations ---------------- */
function sqlHandler(kind:'mysql'|'mssql'):NodeHandler {
  return app({type:`${kind}Node`,label:kind==='mysql'?'MySQL':'Microsoft SQL Server',integration:kind,icon:'database',description:'Execute SQL with bound parameters, TLS and cancellation.',
    credentialFields:[{key:'connectionString',label:'Connection string (or fill server fields)',secret:true},{key:'host',label:'Server'},{key:'port',label:'Port'},{key:'user',label:'Username'},{key:'password',label:'Password',secret:true},{key:'database',label:'Database'},{key:kind==='mysql'?'ssl':'encrypt',label:'TLS (true/false)'},{key:'ca',label:'MySQL CA certificate (optional)'},{key:'trustServerCertificate',label:'SQL Server: trust self-signed certificate (true/false)'}],
    fields:[f.select('action','Action',['runQuery']),{key:'query',label:'SQL',type:'code',required:true},f.json('params','Parameters',{help:kind==='mysql'?'Use ? for parameters.':'Use @p1, @p2… for parameters.'})],outputs:[{path:'queryResult',type:'array'},{path:'rowCount',type:'number'},{path:'fields',type:'array'}],defaults:{action:'runQuery',query:'SELECT 1 AS value',params:'[]'},required:['query'],sideEffect:n=>!/^\s*(select|show|explain)\b/i.test(String(n.values['query']??'')),
    async run(ctx){const params=jsonField(ctx,'params',[]);if(!Array.isArray(params))throw new EngineError('BAD_PAYLOAD','params must be an array');
      let bound=bindSqlTemplates(ctx,str(ctx.values['query']),params,n=>kind==='mysql'?`__jasmine_param_${n}__`:`@p${n}`);
      if(kind==='mysql')bound=mysqlParameters(bound.sql,bound.params,params.length);
      return {output:await queryDatabase(kind,credentialFor(ctx,kind),bound.sql,bound.params,ctx.signal)};
    }
  });
}

export const appHandlers: NodeHandler[] = [
  scraper, crawler, firecrawl, webSearch, rss,
  slack, teams, discord, telegram, mailHandler('smtpNode', 'Email (SMTP)', { to: 'to', isHtml: 'isHtml' }),
  notion, airtable, github, twilio, n8n,
  postgres, tables, s3, mcp,
  ...connectedHandlers,
  sqlHandler('mysql'),sqlHandler('mssql'),
];
