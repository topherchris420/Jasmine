import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { s3Presign } from '../src/integrations/s3.ts';
import { sendMail } from '../src/integrations/smtp.ts';
import { TablesStore } from '../src/integrations/tables.ts';
import { crawl, htmlToMarkdown, scrapePage } from '../src/integrations/web.ts';
import { xmlToJson } from '../src/integrations/xml.ts';
import { createTestApp, fakeFetch } from './helpers.ts';

const trigger = { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } };
const respond = (mapping: string) => ({ id: 'r', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: mapping } } });
const single = (node: { id: string; data: { nodeId: string; values: Record<string, unknown> } }, mapping: string) => ({
  nodes: [trigger, node, respond(mapping)], edges: [{ source: 't', target: node.id }, { source: node.id, target: 'r' }],
});
const html = (title: string, body: string) => new Response(`<html><head><title>${title}</title><meta name="description" content="About ${title}"></head><body><nav><a href="/nav">Nav</a></nav><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html' } });

describe('web scraping and crawling (local engine)', () => {
  it('converts the main content to Markdown with absolute links', async () => {
    expect(htmlToMarkdown('<h2>Title</h2><p>Hello <a href="/x">link</a> and <strong>bold</strong></p><ul><li>a</li><li>b</li></ul><pre><code>x &lt; 1</code></pre>', 'https://site.example/doc/'))
      .toBe('## Title\n\nHello [link](https://site.example/x) and **bold**\n\n- a\n- b\n\n```\nx < 1\n```');
    const page = await scrapePage('https://site.example/a', { fetch: fakeFetch(() => html('A', '<h1>Alpha</h1><p>Body text.</p>')), signal: new AbortController().signal });
    expect(page).toMatchObject({ title: 'A', description: 'About A', statusCode: 200, markdown: '# Alpha\n\nBody text.' });
    expect(page.links).toContain('https://site.example/nav');
  });

  it('crawls within the site, honours robots.txt, depth and limits', async () => {
    const pages: Record<string, string> = {
      '/': '<a href="/docs">Docs</a><a href="/private/x">Private</a><a href="https://other.example/">Other</a>',
      '/docs': '<a href="/docs/deep">Deep</a><a href="/">Home</a>',
      '/docs/deep': '<a href="/docs/deeper">Deeper</a>',
    };
    const fetch = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /private');
      return pages[u.pathname] !== undefined ? html(u.pathname, pages[u.pathname]!) : new Response('nope', { status: 404 });
    });
    const result = await crawl('https://site.example/', { fetch, signal: new AbortController().signal, maxDepth: 2, limit: 10, onlyMainContent: false });
    expect(result.map((p) => new URL(p.url).pathname)).toEqual(['/', '/docs', '/docs/deep']);
    expect(fetch.calls.some((c) => c.url.includes('/private'))).toBe(false);
    expect(fetch.calls.some((c) => c.url.includes('other.example'))).toBe(false);
    const limited = await crawl('https://site.example/', { fetch, signal: new AbortController().signal, limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

describe('app integrations', () => {
  it('sends correctly shaped requests to Slack, Discord, Notion, GitHub, Airtable and Twilio', async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes('slack.com')) return Response.json({ ok: true, ts: '1.2', channel: 'C1' });
      if (url.includes('api.notion.com')) return Response.json({ id: 'page-1', url: 'https://notion.so/page-1' });
      if (url.includes('api.github.com')) return Response.json({ number: 7, html_url: 'https://github.com/o/r/issues/7' }, { status: 201 });
      if (url.includes('api.airtable.com')) return Response.json({ records: [{ id: 'rec1' }] });
      if (url.includes('api.twilio.com')) return Response.json({ sid: 'SM1', status: 'queued' });
      return new Response(null, { status: 204 });
    });
    const t = await createTestApp({ fetch });
    try {
      const { app } = t;
      app.credentials.upsert({ integration: 'slack', name: 'team', data: { botToken: 'xoxb-1' } });
      app.credentials.upsert({ integration: 'discord', name: 'd', data: { webhookUrl: 'https://discord.example/hook' } });
      app.credentials.upsert({ integration: 'notion', name: 'n', data: { token: 'secret_n' } });
      app.credentials.upsert({ integration: 'github', name: 'gh', data: { token: 'ghp_1' } });
      app.credentials.upsert({ integration: 'airtable', name: 'a', data: { token: 'pat1' } });
      app.credentials.upsert({ integration: 'twilio', name: 'tw', data: { accountSid: 'AC1', authToken: 'tok', from: '+15550000' } });
      const cases: [string, Record<string, unknown>, string, unknown][] = [
        ['slackNode', { credentials: 'team', channelName: '#general', text: 'Deployed {{t.output.v}}' }, '{"ts": "{{x.output.ts}}"}', { ts: '1.2' }],
        ['discordNode', { content: 'Hi' }, '{"ok": "{{x.output.ok}}"}', { ok: true }],
        ['notionNode', { action: 'NOTION_CREATE_NOTION_PAGE', databaseId: 'db1', title: 'Report', content: 'Para one\n\nPara two' }, '{"id": "{{x.output.id}}"}', { id: 'page-1' }],
        ['githubNode', { action: 'createIssue', owner: 'o', repo: 'r', title: 'Bug', body: 'Details', labels: ['bug'] }, '{"n": "{{x.output.number}}"}', { n: 7 }],
        ['airtableNode', { action: 'list', baseId: 'app1', tableIdOrName: 'Leads', maxRecords: 5 }, '{"first": "{{x.output.records[0].id}}"}', { first: 'rec1' }],
        ['twilioNode', { action: 'sendSms', to: '+15551111', body: 'Code 123' }, '{"sid": "{{x.output.sid}}"}', { sid: 'SM1' }],
      ];
      for (const [type, values, mapping, expected] of cases) {
        await app.deployments.deploy(type, single({ id: 'x', data: { nodeId: type, values } }, mapping));
        const res = await app.runs.executeWorkflow(type, { v: 'v2' });
        expect(res.output, `${type}: ${JSON.stringify(res.error)}`).toEqual(expected);
      }
      const call = (part: string) => fetch.calls.find((c) => c.url.includes(part))!;
      expect(call('slack.com').init.headers).toMatchObject({ authorization: 'Bearer xoxb-1' });
      expect(JSON.parse(call('slack.com').init.body as string)).toEqual({ channel: 'general', text: 'Deployed v2' });
      expect(JSON.parse(call('discord.example').init.body as string)).toEqual({ content: 'Hi' });
      const notion = JSON.parse(call('api.notion.com').init.body as string);
      expect(notion).toMatchObject({ parent: { database_id: 'db1' }, properties: { Name: { title: [{ text: { content: 'Report' } }] } } });
      expect(notion.children).toHaveLength(2);
      expect(call('api.github.com').url).toBe('https://api.github.com/repos/o/r/issues');
      expect(JSON.parse(call('api.github.com').init.body as string)).toEqual({ title: 'Bug', body: 'Details', labels: ['bug'] });
      expect(call('api.airtable.com').url).toBe('https://api.airtable.com/v0/app1/Leads?maxRecords=5');
      expect(String(call('api.twilio.com').init.body)).toBe('To=%2B15551111&From=%2B15550000&Body=Code+123');
      // Side-effect nodes are never blindly retried and carry no secrets into run logs.
      const logged = JSON.stringify(app.runStore.list({ limit: 50 }));
      expect(logged).not.toContain('xoxb-1');
    } finally {
      await t.close();
    }
  });

  it('explains missing credentials and upstream errors', async () => {
    const t = await createTestApp({ fetch: fakeFetch(() => Response.json({ ok: false, error: 'channel_not_found' })) });
    try {
      await t.app.deployments.deploy('s', single({ id: 'x', data: { nodeId: 'slackNode', values: { text: 'hi', channelName: 'x' } } }, '{}'));
      expect((await t.app.runs.executeWorkflow('s', {})).error?.message).toMatch(/No slack credential/);
      t.app.credentials.upsert({ integration: 'slack', name: 'only', data: { botToken: 'xoxb-2' } });
      expect((await t.app.runs.executeWorkflow('s', {})).error?.message).toBe('Slack: channel_not_found');
    } finally {
      await t.close();
    }
  });

  it('reads RSS and Atom feeds and searches the web through SearXNG', async () => {
    const rss = '<?xml version="1.0"?><rss><channel><title>News</title><item><title>One &amp; two</title><link>https://n.example/1</link><pubDate>Mon, 01 Jan 2026</pubDate></item><item><title><![CDATA[Three <b>]]></title><link>https://n.example/3</link></item></channel></rss>';
    const atom = '<feed><title>Blog</title><entry><title>Post</title><link href="https://b.example/p"/><updated>2026-01-01</updated></entry></feed>';
    const fetch = fakeFetch((url) => url.includes('rss') ? new Response(rss) : url.includes('atom') ? new Response(atom)
      : Response.json({ results: [{ title: 'Jasmine', url: 'https://j.example', content: 'Local AI workflows' }, { title: 'Two', url: 'https://2.example', content: 'x' }] }));
    const t = await createTestApp({ fetch });
    try {
      await t.app.deployments.deploy('rss', single({ id: 'x', data: { nodeId: 'rssNode', values: { url: '{{t.output.url}}', limit: 5 } } }, '{"title": "{{x.output.title}}", "items": "{{x.output.items[:].title}}", "links": "{{x.output.items[:].link}}"}'));
      expect((await t.app.runs.executeWorkflow('rss', { url: 'https://n.example/rss' })).output).toEqual({ title: 'News', items: ['One & two', 'Three <b>'], links: ['https://n.example/1', 'https://n.example/3'] });
      expect((await t.app.runs.executeWorkflow('rss', { url: 'https://b.example/atom' })).output).toEqual({ title: 'Blog', items: ['Post'], links: ['https://b.example/p'] });
      t.app.credentials.upsert({ integration: 'searxng', name: 'local', data: { baseUrl: 'http://127.0.0.1:8888' } });
      await t.app.deployments.deploy('search', single({ id: 'x', data: { nodeId: 'webSearchNode', values: { query: 'local ai', results: 1 } } }, '{"top": "{{x.output.output.organic[0].link}}"}'));
      expect((await t.app.runs.executeWorkflow('search', {})).output).toEqual({ top: 'https://j.example' });
      expect(fetch.calls.at(-1)!.url).toBe('http://127.0.0.1:8888/search?q=local+ai&format=json&categories=general&pageno=1');
      expect(xmlToJson('<a x="1"><b>t</b><b>u</b></a>')).toEqual({ a: { '@x': '1', b: ['t', 'u'] } });
    } finally {
      await t.close();
    }
  });
});

describe('S3 signing', () => {
  it('matches the AWS Signature V4 presigned-URL test vector', () => {
    const url = s3Presign({ endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', forcePathStyle: false },
      'examplebucket', 'test.txt', 86400, new Date('2013-05-24T00:00:00Z'));
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
  });
});

describe('SMTP email', () => {
  it('authenticates and delivers a MIME message to an SMTP server', async () => {
    const transcript: string[] = [];
    let data = '';
    const server = net.createServer((socket) => {
      let inData = false;
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 queued\r\n');
            } else data += `${line}\n`;
            continue;
          }
          transcript.push(line.split(' ')[0]!);
          if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.startsWith('AUTH PLAIN')) socket.write(Buffer.from(line.slice(11), 'base64').toString() === '\0me@example.com\0pw' ? '235 ok\r\n' : '535 bad\r\n');
          else if (line === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await sendMail({ host: '127.0.0.1', port, secure: false, username: 'me@example.com', password: 'pw', from: 'Jasmine <me@example.com>' },
        { to: ['a@example.com'], cc: ['b@example.com'], subject: 'Weekly report ✓', body: 'Hello there' }, new AbortController().signal);
      expect(result.accepted).toEqual(['a@example.com', 'b@example.com']);
      expect(transcript).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
      expect(data).toContain('Subject: =?UTF-8?B?');
      expect(data).toContain(Buffer.from('Hello there').toString('base64'));
      await expect(sendMail({ host: '127.0.0.1', port, secure: false, username: 'me@example.com', password: 'wrong', from: 'me@example.com' }, { to: ['a@example.com'], subject: 's', body: 'b' }, new AbortController().signal))
        .rejects.toThrow(/authentication failed/);
      await expect(sendMail({ host: '127.0.0.1', port, secure: false, from: 'me@example.com' }, { to: ['bad\r\nRCPT TO:<x@y>'], subject: 's', body: 'b' }, new AbortController().signal)).rejects.toThrow(/Invalid email/);
    } finally {
      server.close();
    }
  });
});

describe('local tables', () => {
  it('supports typed CRUD, filters and read-only SQL', () => {
    const store = new TablesStore(':memory:');
    try {
      store.create('leads', [{ name: 'name', type: 'text' }, { name: 'score', type: 'number' }, { name: 'won', type: 'boolean' }, { name: 'meta', type: 'json' }]);
      expect(() => store.create('leads', [])).toThrow(/already exists/);
      expect(() => store.create('x;drop', [])).toThrow();
      expect(store.insert('leads', [{ name: 'Ada', score: 9, won: true, meta: { src: 'web' } }, { name: 'Bob', score: 4, won: false }])).toMatchObject({ insertedCount: 2 });
      expect(() => store.insert('leads', { nope: 1 })).toThrow(/no column "nope"/);
      const hot = store.select('leads', { where: { conditions: [{ column: 'score', operator: '>', value: 5 }] } });
      expect(hot.rows).toMatchObject([{ name: 'Ada', score: 9, won: true, meta: { src: 'web' } }]);
      expect(store.select('leads', { where: { conjunction: 'OR', conditions: [{ column: 'name', operator: 'ilike', value: 'b%' }, { column: 'won', operator: '=', value: true }] } }).count).toBe(2);
      expect(store.update('leads', { won: true }, { conditions: [{ column: 'name', operator: '=', value: 'Bob' }] })).toEqual({ updatedCount: 1 });
      expect(() => store.update('leads', { won: true }, undefined)).toThrow(/where/);
      expect(store.query('SELECT name FROM leads WHERE score > ? ORDER BY name', [1]).rows).toEqual([{ name: 'Ada' }, { name: 'Bob' }]);
      expect(() => store.query('DELETE FROM leads')).toThrow(/Only a single SELECT/);
      expect(() => store.query('SELECT 1; DELETE FROM leads')).toThrow(/Only a single SELECT/);
      expect(store.delete('leads', { conditions: [{ column: 'id', operator: 'in', value: [1] }] })).toEqual({ deletedCount: 1 });
      expect(store.list()).toMatchObject([{ name: 'leads', rows: 1 }]);
    } finally {
      store.close();
    }
  });

  it('binds templates inside SQL as parameters, so upstream values cannot inject SQL', async () => {
    const t = await createTestApp();
    try {
      t.app.tables.create('users', [{ name: 'name', type: 'text' }]);
      t.app.tables.insert('users', [{ name: 'alice' }, { name: "o'brien" }]);
      await t.app.deployments.deploy('q', single({ id: 'x', data: { nodeId: 'tablesNode', values: { action: 'query', query: "SELECT name FROM users WHERE name = '{{t.output.name}}'" } } }, '{"rows": "{{x.output.rows}}"}'));
      expect((await t.app.runs.executeWorkflow('q', { name: "o'brien" })).output).toEqual({ rows: [{ name: "o'brien" }] });
      expect((await t.app.runs.executeWorkflow('q', { name: "x' OR '1'='1" })).output).toEqual({ rows: [] });
    } finally {
      await t.close();
    }
  });
});
