import { api } from '../api.js';
import { statusList } from '../shared.js';
import { badge, busy, button, card, confirmDialog, field, fill, h, icon, modal, ms, num, page, select, timeAgo, toast } from '../ui.js';

const STATUS = {
  installed: ['Installed', 'success'], outdated: ['Update available', 'warning'], available: ['Not installed', 'neutral'],
  installing: ['Installing…', 'info'], failed: ['Install failed', 'danger'],
};
const CATEGORY = { app: 'app and service', rag: 'retrieval', ai: 'AI', trigger: 'trigger', logic: 'logic', data: 'data', response: 'response' };

/**
 * Jasmine on herself: her identity, what she can do here, what she knows (knowledge packs) and how she has been doing.
 * Everything except the identity is measured by the runtime when the page opens, and model reachability is checked
 * after the page is usable. Nothing is installed until you press Install.
 */
export async function render(container, _params, { navigate }) {
  let self = await api.get('/api/self?detail=state');
  let packs = (await api.get('/api/knowledge/packs')).packs;
  let timer = null;
  // Reachability from the last probe, kept across refreshes that do not probe again; null until the probe answers.
  let reach = null;
  let probing = true;
  const withReach = (described) => {
    for (const c of described.models.connections) if (c.reachable === undefined && reach?.[c.connection]) Object.assign(c, reach[c.connection]);
    return described;
  };
  const statsBox = h('div');
  const knowledgeBox = h('div', { class: 'stack-sm' });
  const nowBox = h('div');
  const limitsBox = h('div');

  const draw = () => {
    fill(statsBox, stats(self, packs));
    fill(knowledgeBox, knowledge(packs, { install, remove }));
    fill(nowBox, rightNow(self, probing));
    fill(limitsBox, limits(self));
  };
  const refreshPacks = async () => {
    packs = (await api.get('/api/knowledge/packs')).packs;
    self = withReach(await api.get('/api/self?detail=state'));
    draw();
    clearTimeout(timer);
    if (packs.some((p) => p.status === 'installing')) timer = setTimeout(() => void refreshPacks().catch(() => {}), 1000);
  };

  /** Installs `pack`, then `more` into the same collection; the first install creates the collection, so later ones reuse its model. */
  async function install(pack, more = []) {
    const collection = await api.get('/api/collections?kind=knowledge').then((list) => list.find((c) => c.name === pack.collection)).catch(() => undefined);
    const start = async (body) => {
      for (const [p, b] of [[pack, body], ...more.map((m) => [m, {}])]) {
        try {
          await api.post(`/api/knowledge/packs/${encodeURIComponent(p.id)}/install`, b);
          toast(`Installing ${p.title}`, 'info', 2500);
        } catch (e) { toast(e.message, 'error'); }
      }
      await refreshPacks();
    };
    // A collection's passages share one embedding model, chosen when its first pack is installed.
    if (collection) return start({});
    const models = await api.get('/api/models').catch(() => []);
    const options = [
      { value: '', label: 'Project default embedding model' },
      ...models.filter((m) => m.ok).flatMap((m) => m.models.filter((x) => x.kind === 'embedding').map((x) => ({ value: `${m.connection}::${x.id}`, label: `${m.name}: ${x.id}` }))),
    ];
    // Prefer a learned embedding model when one is connected; the built-in one only matches shared words.
    const learned = models.filter((m) => m.ok && m.kind !== 'builtin' && m.kind !== 'mock').flatMap((m) => m.models.filter((x) => x.kind === 'embedding').map((x) => `${m.connection}::${x.id}`));
    let choice = learned[0] ?? '';
    modal({
      title: more.length ? 'Install knowledge packs' : `Install ${pack.title}`,
      body: h('div', { class: 'stack' },
        h('p', {}, `${num([pack, ...more].reduce((n, p) => n + p.documents, 0))} documents go into the “${pack.collection}” knowledge collection, where every pack is searched together.`),
        field('Embedding model', Object.assign(select(options, choice, (v) => (choice = v)), { value: choice }), 'Every pack in the collection uses this model. A learned model such as nomic-embed-text finds passages by meaning; the built-in keyword option only matches shared words. Embedding takes a minute or two on a laptop.')),
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Install', kind: 'primary', icon: 'download', onClick: async (close) => {
        const [embeddingConnection, embeddingModel] = choice ? choice.split('::') : [null, null];
        close();
        await start({ embeddingConnection, embeddingModel });
      } }],
    });
  }

  async function remove(pack) {
    if (!await confirmDialog(`Remove ${pack.title}? Its ${num(pack.installed?.present ?? pack.documents)} documents leave “${pack.collection}”. Workflows that search them will stop finding them. You can install it again at any time.`, { danger: true, confirmLabel: 'Remove' })) return;
    try {
      await api.del(`/api/knowledge/packs/${encodeURIComponent(pack.id)}`);
      toast(`${pack.title} removed`, 'success');
      await refreshPacks();
    } catch (e) { toast(e.message, 'error'); }
  }

  const installAll = button('Install all', { icon: 'download', onClick: async (e) => busy(e.currentTarget, async () => {
    const todo = packs.filter((p) => p.status === 'available' || p.status === 'outdated' || p.status === 'failed');
    if (!todo.length) return toast('Every knowledge pack is installed and up to date.', 'success');
    return install(todo[0], todo.slice(1));
  }) });

  const createChat = button('Chat with me', { kind: 'primary', icon: 'chat', title: 'Create the “Ask Jasmine” workflow from its template', onClick: (e) => busy(e.currentTarget, async () => {
    try {
      const flow = await api.post('/api/flows', { templateId: 'ask-jasmine' });
      navigate(`/flows/${encodeURIComponent(flow.id)}?from=template`);
    } catch (err) { toast(err.message, 'error'); }
  }) });

  container.append(page('About Jasmine', 'Who I am, what I can do here, what I know and how I have been doing. Everything except who I am is measured from this runtime when you open the page.', [createChat],
    identity(self),
    statsBox,
    h('div', { class: 'grid grid-2' }, card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Right now'), h('p', {}, 'Measured just now'))), nowBox),
      card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'What I cannot do'), h('p', {}, 'What stops me right now, then what always holds'))), limitsBox)),
    h('section', { class: 'card', id: 'knowledge' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'What I know'), h('p', {}, 'Knowledge packs: document sets built from pinned versions of their sources. Workflows search them like any knowledge collection.')), installAll),
      knowledgeBox),
    h('div', { class: 'callout callout-info' }, icon('eye'), h('div', {}, h('strong', {}, 'What self-awareness means here'), h('p', {}, self.awareness)))));
  draw();
  if (location.hash === '#knowledge') container.querySelector('#knowledge')?.scrollIntoView?.({ block: 'start' });
  if (packs.some((p) => p.status === 'installing')) timer = setTimeout(() => void refreshPacks().catch(() => {}), 1000);

  // Reachability takes a network round trip per connection, so it fills in after the page is usable.
  api.get('/api/self?detail=state&probe=true').then((probed) => {
    reach = Object.fromEntries(probed.models.connections.map((c) => [c.connection, { reachable: c.reachable, error: c.error }]));
    self = withReach(self);
  }).catch(() => {}).finally(() => {
    probing = false;
    if (container.isConnected) draw();
  });

  return () => clearTimeout(timer);
}

function identity(self) {
  const i = self.identity;
  return card(
    h('div', { class: 'eyebrow' }, `${i.lab} · ${i.role}`),
    h('h2', { style: { margin: '6px 0 4px', fontSize: '22px' } }, `I am ${i.name}.`),
    h('p', { class: 'lede', style: { marginTop: 0 } }, `${i.purpose} My question is always “${i.question}”`),
    h('p', { class: 'small muted', style: { margin: '-4px 0 0' } }, i.motto),
    h('div', { class: 'grid grid-2', style: { marginTop: '12px' } },
      h('div', {}, h('div', { class: 'field-label' }, 'Principles'), h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } }, i.principles.map((p) => h('li', {}, p)))),
      h('div', { class: 'stack-sm' },
        h('div', {}, h('div', { class: 'field-label' }, 'How I speak'), h('p', { class: 'small', style: { margin: '6px 0 0' } }, i.voice.join(' '))),
        h('div', {}, h('div', { class: 'field-label' }, 'My colleagues in the lab'), h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } }, i.colleagues.map((c) => h('li', {}, h('strong', {}, c.name), ` · ${c.role}: ${c.relation}`)))),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'My lab identity comes from ', h('a', { href: i.origin.soul.url, target: '_blank', rel: 'noopener noreferrer' }, i.origin.soul.path), ` (sha256 ${i.origin.soul.sha256.slice(0, 12)}…) in the R.A.I.N. Lab.`))));
}

function stats(self, packs) {
  const e = self.experience;
  const m = self.models;
  const installed = packs.filter((p) => p.status === 'installed' || p.status === 'outdated');
  const stat = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value truncate', title: value }, value), h('div', { class: 'stat-note' }, note));
  return h('div', { class: 'grid grid-4 stats', role: 'group', 'aria-label': 'How I am doing' },
    stat('Runs · 7 days', num(e.runs), e.runs ? `${Math.round((e.successRate ?? 0) * 100)}% succeeded` : 'No runs yet'),
    stat('Median latency', ms(e.p50Ms), e.p95Ms ? `p95 ${ms(e.p95Ms)}` : 'Appears after a run'),
    stat('Answering model', m.demoOnly ? 'Demo only' : (m.answering?.model ?? 'Default'), m.demoOnly ? 'No AI inference until you connect a model' : `${m.answering?.name ?? ''}${m.answering?.local ? ' · this machine' : ''}`),
    stat('Knowledge packs', `${installed.length} of ${packs.length}`, installed.length ? `${num(installed.reduce((n, p) => n + (p.installed?.present ?? 0), 0))} documents` : 'Install them below'));
}

function rightNow(self, probing) {
  const a = self.abilities;
  const r = self.runtime;
  const categories = Object.entries(a.byCategory).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${CATEGORY[k] ?? k}`).join(', ');
  const models = self.models.connections.map((c) => ({
    status: c.reachable === false ? 'missing' : c.reachable ? 'ready' : 'info',
    title: `${c.name}${c.defaultChat ? ' (answers by default)' : ''}`,
    detail: [c.kind === 'mock' ? 'Demo responses, no inference' : c.chatModel ?? 'No chat model set', c.embeddingModel ? `embeddings: ${c.embeddingModel}` : '', c.local ? 'on this machine' : c.local === false ? 'on another server' : '', c.reachable === undefined ? (probing ? 'checking…' : '') : c.reachable ? 'reachable' : `not reachable${c.error ? `: ${c.error}` : ''}`].filter(Boolean).join(' · '),
    ...(c.reachable === false ? { action: { label: 'Diagnose', href: `/models?diagnose=${encodeURIComponent(c.connection)}` } } : {}),
  }));
  return h('div', { class: 'stack' },
    models.length ? statusList(models, { compact: true }) : h('p', { class: 'muted' }, 'No model connections yet.'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Steps'), h('dd', {}, `${a.steps} kinds (${categories})`),
      h('dt', {}, 'Planner'), h('dd', {}, `${a.applications.length} kinds of application from a description`),
      h('dt', {}, 'Templates'), h('dd', {}, String(a.templates)),
      h('dt', {}, 'Workflows'), h('dd', {}, `${r.workflows} (${r.deployed} deployed), ${r.load.active} running, ${r.load.queued} queued`),
      h('dt', {}, 'Runtime'), h('dd', {}, `Jasmine ${r.version} · Node.js ${r.node} · ${r.platform} · ${r.hosted ? 'hosted' : 'local'}${r.persistent ? '' : ' · in-memory storage'}`),
      h('dt', {}, 'Up since'), h('dd', {}, timeAgo(r.startedAt))));
}

function limits(self) {
  return h('ul', { class: 'small', style: { margin: 0, paddingLeft: '18px' } }, self.limits.map((l) => h('li', { style: { marginBottom: '6px' } }, l)));
}

function knowledge(packs, { install, remove }) {
  return packs.map((p) => {
    const [label, kind] = STATUS[p.status] ?? [p.status, 'neutral'];
    const job = p.job;
    const sources = p.sources.map((s) => h('a', { href: s.commit ? `${s.url}/tree/${s.commit}` : s.url, target: '_blank', rel: 'noopener noreferrer' }, `${s.repository}${s.commit ? `@${s.commit.slice(0, 7)}` : s.version ? ` ${s.version}` : ''}`));
    return h('div', { class: 'attention-item', style: { alignItems: 'flex-start' } },
      h('span', { class: 'icon-wrap' }, icon(p.id === 'openai-math' ? 'sparkles' : p.id === 'jasmine-docs' ? 'docs' : 'database', 16)),
      h('div', { class: 'grow stack-sm' },
        h('div', { class: 'row row-wrap' }, h('strong', {}, p.title), badge(label, kind), h('span', { class: 'small muted' }, `${num(p.documents)} documents`)),
        h('div', { class: 'small' }, p.description),
        p.status === 'installing' && job ? h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': job.total || 1, 'aria-valuenow': job.done, 'aria-label': `Installing ${p.title}` }, h('span', { style: { width: `${job.total ? Math.round((job.done / job.total) * 100) : 3}%` } })) : null,
        job?.error ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, job.error) : null,
        p.installed ? h('div', { class: 'small muted' }, `In “${p.installed.collection}” since ${timeAgo(p.installed.installedAt)} · ${num(p.installed.chunks)} passages${p.installed.embeddingModel ? ` · ${p.installed.embeddingModel}` : ''}`) : null,
        h('details', { class: 'small' }, h('summary', {}, 'Caveats, sources and license'),
          h('ul', { style: { margin: '6px 0', paddingLeft: '18px' } }, p.caveats.map((c) => h('li', {}, c))),
          h('div', { class: 'row row-wrap muted' }, 'Sources:', ...sources),
          h('p', { class: 'muted', style: { margin: '4px 0 0' } }, `${p.license}. ${p.notice}`))),
      h('div', { class: 'row' },
        p.status === 'installed' || p.status === 'installing' ? null : button(p.status === 'outdated' ? 'Update' : p.status === 'failed' ? 'Retry' : 'Install', { size: 'sm', kind: p.status === 'outdated' ? 'primary' : 'secondary', icon: 'download', onClick: (e) => busy(e.currentTarget, () => install(p)) }),
        p.installed && p.status !== 'installing' ? button('', { size: 'sm', kind: 'ghost', icon: 'trash', title: `Remove ${p.title}`, onClick: (e) => busy(e.currentTarget, () => remove(p)) }) : null));
  });
}
