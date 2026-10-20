import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/errors.ts';
import { MockLLMProvider } from '../src/llm/providers.ts';
import type { EmbedRequest, EmbedResponse } from '../src/llm/types.ts';
import { IDENTITY } from '../src/service/identity.ts';
import { KNOWLEDGE_DIR, PACK_COLLECTION, parsePack } from '../src/service/packs.ts';
import { cleanMarkdown, headingAnchor, markdownSections } from '../src/vector/markdown.ts';
import { createTestApp, jsonRequest, withHttp } from './helpers.ts';

/** Embeds the first `ok` batches, then fails like a model server that went away. */
class FailingEmbeddings extends MockLLMProvider {
  ok: number;
  constructor(ok: number) {
    super();
    this.ok = ok;
  }
  override async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (this.embedCalls >= this.ok) throw new EngineError('PROVIDER', 'The embedding server went away');
    return super.embed(req);
  }
}

/** Holds every embedding call until the test opens the gate, so an install is still running when the test looks. */
class GatedEmbeddings extends MockLLMProvider {
  open!: () => void;
  gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  override async embed(req: EmbedRequest): Promise<EmbedResponse> {
    await this.gate;
    return super.embed(req);
  }
}

const bundled = async (file: string) => JSON.parse(await readFile(new URL(file, KNOWLEDGE_DIR), 'utf8')) as Record<string, any>;

describe('Markdown to knowledge', () => {
  it('keeps the words people search for and drops badges, images, HTML and long listings', () => {
    const md = [
      '<p align="center"><img src="banner.svg" alt="banner"></p>',
      '[![CI](https://ci/badge.svg)](https://ci) ![logo](logo.png)',
      '**Bold claim** with a [link to docs](https://example.com/docs) and `inline code`.',
      '',
      '> [!WARNING]',
      '> Not for flight.',
      '',
      '| Stage | Evidence |',
      '| --- | --- |',
      '| Observe | Raw &amp; synced samples |',
      '',
      '### Run it',
      '```bash',
      'npm ci',
      '```',
      '```js',
      'x'.repeat(500),
      '```',
    ].join('\n');
    const text = cleanMarkdown(md);
    expect(text).toContain('Bold claim with a link to docs and inline code.');
    expect(text).toContain('Warning: Not for flight.');
    expect(text).toContain('Observe — Raw & synced samples');
    expect(text).toContain('Run it:\nnpm ci');
    expect(text).not.toMatch(/badge|banner|logo\.png|https:|<|\|/);
    expect(text).not.toContain('xxxxx');
  });

  it('splits at the title and level-2 headings, outside code fences, with GitHub anchors', () => {
    const sections = markdownSections('# CIRCLE\nIntro text.\n\n## How CIRCLE works\nIt closes the loop.\n```sh\n# not a heading\n```\n## Empty\n\n## Status & limits\nSimulation only.');
    expect(sections.map((s) => [s.heading, s.level, s.anchor])).toEqual([['CIRCLE', 1, 'circle'], ['How CIRCLE works', 2, 'how-circle-works'], ['Status & limits', 2, 'status--limits']]);
    expect(sections[1]!.text).toContain('# not a heading');
    expect(headingAnchor('What the evidence says?')).toBe('what-the-evidence-says');
  });
});

describe('Knowledge packs', () => {
  it('loads every bundled pack, checks its content hash and records where it came from', async () => {
    const t = await createTestApp();
    try {
      expect(await t.app.packs.problems()).toEqual([]);
      const packs = await t.app.packs.list();
      expect(packs.map((p) => p.id)).toEqual(['jasmine-docs', 'openai-math', 'rain-lab', 'vers3dynamics-projects']);
      for (const p of packs) {
        expect(p).toMatchObject({ status: 'available', installed: null, collection: PACK_COLLECTION });
        expect(p.caveats.length).toBeGreaterThan(0);
        if (p.origin === 'bundled') for (const s of p.sources) expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
      }
      const math = packs.find((p) => p.id === 'openai-math')!;
      expect(math.sources.map((s) => s.repository)).toEqual(['openai/math', 'topherchris420/lop-nur-twin']);
      expect(math.caveats.join(' ')).toMatch(/has not compiled or checked any proof/);
    } finally {
      await t.close();
    }
  });

  it('refuses a pack whose documents were edited after it was built', async () => {
    const pack = await bundled('rain-lab.json');
    expect(parsePack(pack).documents.length).toBe(pack['documents'].length);
    pack['documents'][0].text += ' Edited by hand.';
    expect(() => parsePack(pack)).toThrow(/does not match its content hash/);
    expect(() => parsePack({ ...pack, schema: 'something-else' })).toThrow(/Not a knowledge pack/);
  });

  it('keeps the verification status of every openai/math result', async () => {
    const t = await createTestApp();
    try {
      const math = await t.app.packs.get('openai-math');
      const families = math.documents.filter((d) => d.metadata['kind'] === 'math-result');
      expect(families).toHaveLength(372);
      expect(families.filter((d) => d.metadata['verification'] === 'formalized')).toHaveLength(235);
      for (const d of families) {
        expect(d.text).toMatch(d.metadata['verification'] === 'formalized' ? /^Formalized: the catalogue records a Lean formalization/m : /^Manuscript only: no Lean formalization is catalogued/m);
        expect(d.url).toMatch(/^https:\/\/github\.com\/openai\/math\/(blob|tree)\/[0-9a-f]{40}/);
      }
      const zeta = families.find((d) => d.metadata['family'] === '003')!;
      expect(zeta.title).toBe('openai/math 003 · The quasi-Riemann hypothesis');
      expect(zeta.text).toContain('OAI.riemannZeta_ne_zero_of_seven_eighths_lt_re');
      expect(math.documents.find((d) => d.id === 'openai-math:overview')!.text).toMatch(/235 families have a catalogued Lean formalization; 137 are manuscript only/);
    } finally {
      await t.close();
    }
  });

  it('carries Jasmine’s soul with the hash her identity cites, and the rest of the lab', async () => {
    const t = await createTestApp();
    try {
      const lab = await t.app.packs.get('rain-lab');
      const soul = lab.documents.find((d) => d.id === 'rain-lab:soul:jasmine')!;
      expect(soul.metadata).toMatchObject({ kind: 'persona', perspective: 'Jasmine', sha256: IDENTITY.origin.soul.sha256 });
      expect(soul.text).toMatch(/^Jasmine is one of the four research perspectives.*not verified engineering data/);
      expect(lab.documents.filter((d) => d.metadata['kind'] === 'persona').map((d) => d.metadata['perspective'])).toEqual(['James', 'Jasmine', 'Luca', 'Elena']);
      const projects = await t.app.packs.get('vers3dynamics-projects');
      expect(projects.documents[0]!.id).toBe('projects:index');
      expect(projects.sources).toHaveLength(25);
      expect(projects.documents.some((d) => d.title.startsWith('CIRCLE'))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('generates Jasmine’s own documentation pack from this installation', async () => {
    const t = await createTestApp();
    try {
      const docs = await t.app.packs.get('jasmine-docs');
      expect(docs.origin).toBe('generated');
      const byId = new Map(docs.documents.map((d) => [d.id, d]));
      expect(byId.get('jasmine-docs:identity')!.text).toContain('I am Jasmine, a local-first AI workflow platform');
      expect(byId.get('jasmine-docs:steps:ai')!.text).toContain('About Jasmine: Tells your model who Jasmine is, what she can do here and what she cannot.');
      expect(byId.get('jasmine-docs:templates')!.text).toContain('Ask Jasmine (Chat)');
      expect([...byId.keys()].some((id) => id.startsWith('jasmine-docs:README.md#'))).toBe(true);
      expect([...byId.keys()].some((id) => id.startsWith('jasmine-docs:knowledge/README.md'))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('installs packs into one collection, searches them together, updates and removes them', async () => {
    const t = await createTestApp();
    try {
      const started = await t.app.packs.install('rain-lab');
      expect(started.status).toBe('installing');
      expect((await t.app.packs.wait('rain-lab')).status).toBe('installed');
      await t.app.packs.install('vers3dynamics-projects');
      const projects = await t.app.packs.wait('vers3dynamics-projects');
      expect(projects.installed).toMatchObject({ collection: PACK_COLLECTION, documents: 188, present: 188, embeddingModel: expect.any(String) });
      const collection = t.app.vectors.getCollection(PACK_COLLECTION)!;
      expect(collection.documents).toBe(33 + 188);

      // Chunks are indexed under their document's title, so a name finds its own document first.
      const elena = t.app.vectors.search(PACK_COLLECTION, { mode: 'keyword', query: 'Who is Elena?', limit: 3 });
      expect(elena[0]!.metadata).toMatchObject({ pack: 'rain-lab', title: expect.stringMatching(/^Elena — /), url: expect.stringContaining('ELENA_SOUL.md') });
      expect(elena[0]!.metadata['content']).not.toMatch(/^Elena — /);
      const circle = t.app.vectors.search(PACK_COLLECTION, { mode: 'keyword', query: 'CIRCLE human authority haptic', limit: 3 });
      expect(circle[0]!.metadata['title']).toMatch(/^CIRCLE/);

      // An installed pack whose content changed is reported, and updating replaces the old copy.
      const record = t.app.settings.get<Record<string, { contentSha256: string }>>('knowledge.packs', {});
      t.app.settings.set('knowledge.packs', { ...record, 'rain-lab': { ...record['rain-lab']!, contentSha256: 'stale' } });
      expect((await t.app.packs.describe('rain-lab')).status).toBe('outdated');
      await t.app.packs.install('rain-lab');
      expect((await t.app.packs.wait('rain-lab')).status).toBe('installed');
      expect(t.app.vectors.getCollection(PACK_COLLECTION)!.documents).toBe(33 + 188);

      expect(await t.app.packs.remove('rain-lab')).toEqual({ removed: 33, collectionDeleted: false });
      expect((await t.app.packs.describe('rain-lab')).status).toBe('available');
      expect(t.app.vectors.search(PACK_COLLECTION, { mode: 'keyword', query: 'Elena', limit: 5 }).every((h) => h.metadata['pack'] !== 'rain-lab')).toBe(true);
      expect(await t.app.packs.remove('vers3dynamics-projects')).toEqual({ removed: 188, collectionDeleted: true });
      expect(t.app.vectors.getCollection(PACK_COLLECTION)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it('keeps nothing from a failed install, and keeps the installed copy when an update fails', async () => {
    const t = await createTestApp({ llm: new FailingEmbeddings(2) });
    try {
      // rain-lab fits in two embedding batches; after those the server is gone.
      await t.app.packs.install('rain-lab');
      expect((await t.app.packs.wait('rain-lab')).status).toBe('installed');
      await t.app.packs.install('openai-math');
      const failed = await t.app.packs.wait('openai-math');
      expect(failed).toMatchObject({ status: 'failed', installed: null, job: { error: 'The embedding server went away' } });
      expect(t.app.vectors.getCollection(PACK_COLLECTION)!.documents).toBe(33);
      expect(t.app.vectors.search(PACK_COLLECTION, { mode: 'keyword', query: 'Riemann zeta', limit: 5 })).toEqual([]);

      const record = t.app.settings.get<Record<string, { contentSha256: string }>>('knowledge.packs', {});
      t.app.settings.set('knowledge.packs', { ...record, 'rain-lab': { ...record['rain-lab']!, contentSha256: 'stale' } });
      await t.app.packs.install('rain-lab');
      expect(await t.app.packs.wait('rain-lab')).toMatchObject({ status: 'failed', installed: { present: 33 } });
      expect(t.app.vectors.getCollection(PACK_COLLECTION)!.documents).toBe(33);
    } finally {
      await t.close();
    }
  });

  it('is managed over the API, which refuses unknown packs, bad input and a second install at once', async () => {
    const llm = new GatedEmbeddings();
    const t = await createTestApp({ llm });
    try {
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        const listed = await req('/api/knowledge/packs');
        expect(listed.status).toBe(200);
        expect(listed.data.problems).toEqual([]);
        expect(listed.data.packs.map((p: { id: string }) => p.id)).toContain('openai-math');
        expect((await req('/api/knowledge/packs/nope/install', 'POST', {})).status).toBe(404);
        expect((await req('/api/knowledge/packs/rain-lab/install', 'POST', { collection: 'bad name!' })).status).toBe(400);
        expect((await req('/api/knowledge/packs/rain-lab/install', 'POST', { surprise: true })).status).toBe(400);
        const started = await req('/api/knowledge/packs/rain-lab/install', 'POST', { collection: 'lab', embeddingConnection: null, embeddingModel: null });
        expect(started.status).toBe(202);
        expect(started.data).toMatchObject({ id: 'rain-lab', status: 'installing', collection: 'lab' });
        expect((await req('/api/knowledge/packs/rain-lab/install', 'POST', {})).status).toBe(409);
        expect((await req('/api/knowledge/packs/rain-lab', 'DELETE')).status).toBe(409);
        llm.open();
        await t.app.packs.wait('rain-lab');
        expect((await req('/api/knowledge/packs/rain-lab')).data).toMatchObject({ status: 'installed', collection: 'lab', installed: { present: 33 } });
        expect((await req('/api/knowledge/packs/rain-lab', 'DELETE')).data).toEqual({ removed: 33, collectionDeleted: false });
        expect((await req('/api/collections/lab')).status).toBe(200);
      });
    } finally {
      await t.close();
    }
  });
});
