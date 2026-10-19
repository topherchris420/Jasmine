import { api } from '../api.js';
import { jsonPanel, badge, busy, button, card, confirmDialog, field, fill, h, icon, input, modal, ms, page, select, textarea, toast } from '../ui.js';
import { statusList } from '../shared.js';

const KINDS = [
  { value: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434', help: 'Native Ollama API. Pull models with `ollama pull llama3.2` and `ollama pull nomic-embed-text`.' },
  { value: 'openai', label: 'OpenAI-compatible API', url: 'http://127.0.0.1:1234/v1', help: 'Hosted OpenAI-compatible providers, LM Studio, llama.cpp and vLLM. The URL includes /v1. On a hosted runtime, localhost refers to the runtime itself.' },
  { value: 'mock', label: 'Demo responses (no AI model)', url: '', help: 'Echoes prompts back and fills structured fields with placeholders. Useful for trying workflows; it performs no AI inference.' },
];

export async function render(container, _params, { query } = {}) {
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const [{ connections, defaults }, status] = await Promise.all([api.get('/api/models/connections'), api.get('/api/models').catch(() => [])]);
    const byId = new Map(status.map((s) => [s.connection, s]));
    const chatOptions = connections.filter((c) => c.kind !== 'builtin').map((c) => ({ value: c.id, label: c.name }));
    const embedOptions = connections.map((c) => ({ value: c.id, label: c.kind === 'builtin' ? 'Built-in lexical (no model server)' : c.name }));
    fill(body, 
      card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Defaults'), h('p', {}, 'Nodes without an explicit model use these. Imported flows that name cloud models (OpenAI, Anthropic, Gemini…) run here too.'))),
        h('div', { class: 'grid grid-2' },
          field('Chat & generation', select([{ value: '', label: 'First available connection' }, ...chatOptions], defaults.chat ?? '', async (v) => { await api.put('/api/models/defaults', { chat: v || null }); toast('Default chat connection saved', 'success'); })),
          field('Embeddings', select([{ value: '', label: 'Automatic (first connection with an embedding model)' }, ...embedOptions], defaults.embedding ?? '', async (v) => { await api.put('/api/models/defaults', { embedding: v || null }); toast('Default embedding connection saved', 'success'); })))),
      h('div', { class: 'row spread' }, h('h2', {}, 'Connections'), button('Add connection', { kind: 'primary', icon: 'plus', onClick: () => edit(null, draw) })),
      h('div', { class: 'tiles' }, connections.map((c) => {
        const s = byId.get(c.id);
        return h('div', { class: 'card stack-sm' },
          h('div', { class: 'row' }, h('span', { class: 'tile-icon' }, icon(c.kind === 'builtin' ? 'sparkles' : 'models', 18)), h('div', { class: 'grow' }, h('h3', {}, c.name), h('div', { class: 'muted small' }, c.kind === 'openai' ? 'OpenAI-compatible' : c.kind)),
            s ? badge(s.ok ? 'online' : 'offline', s.ok ? 'success' : 'danger') : badge('unknown', 'neutral')),
          c.baseUrl ? h('code', { class: 'small truncate' }, c.baseUrl) : null,
          s && !s.ok ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, s.error) : null,
          s?.ok ? h('div', { class: 'small muted' }, s.models.length ? s.models.map((m) => `${m.id}${m.kind === 'embedding' ? ' (embed)' : ''}`).join(' · ') : 'No models found') : null,
          h('div', { class: 'row row-wrap' }, c.defaultChat ? badge('default chat', 'accent') : null, c.defaultEmbedding ? badge('default embeddings', 'accent') : null, c.chatModel ? badge(`chat: ${c.chatModel}`, 'neutral') : null, c.embeddingModel ? badge(`embed: ${c.embeddingModel}`, 'neutral') : null, c.hasApiKey ? badge('API key', 'neutral') : null),
          c.kind === 'mock' ? h('div', { class: 'demo-note' }, icon('info', 14), h('span', {}, 'Demo responses: no AI inference runs.')) : null,
          c.kind === 'builtin' ? h('p', { class: 'muted small' }, 'Feature-hashing embeddings that need no server. They match shared words, not meaning; use a real embedding model for semantic search.') : h('div', { class: 'row row-wrap' },
            c.kind === 'ollama' || c.kind === 'openai' ? button('Diagnose', { size: 'sm', icon: 'refresh', kind: s && !s.ok ? 'primary' : 'secondary', onClick: () => diagnose(c) }) : null,
            button('Edit', { size: 'sm', icon: 'edit', onClick: () => edit(c, draw) }),
            button('Delete', { size: 'sm', kind: 'ghost', icon: 'trash', onClick: async () => {
              if (!await confirmDialog(`Delete the ${c.name} connection? Nodes pinned to it fall back to the default connection.`, { danger: true, confirmLabel: 'Delete' })) return;
              await api.del(`/api/models/connections/${c.id}`);
              void draw();
            } })));
      })),
      playground(connections), comparisons(connections));
  };
  container.append(page('Models', 'Connect hosted providers or inference servers you control. Requests come from the Jasmine runtime, and credentials are encrypted there. Nothing ever switches to a cloud model on its own.', [
    h('a', { href: '/setup?path=connect', 'data-link': '', class: 'btn btn-secondary' }, icon('search', 16), h('span', {}, 'Find a model server')),
    button('Refresh status', { icon: 'refresh', onClick: () => void draw() })], body));
  await draw();
  const wanted = query?.get('diagnose');
  if (wanted) {
    const { connections, defaults } = await api.get('/api/models/connections');
    const target = connections.find((c) => c.id === wanted) ?? connections.find((c) => c.id === defaults.chat && (c.kind === 'ollama' || c.kind === 'openai')) ?? connections.find((c) => c.kind === 'ollama' || c.kind === 'openai');
    if (target) diagnose(target);
    else toast('There is no model server connection to diagnose yet', 'info');
  }
}

/** Runs the runtime-side diagnosis for a saved connection and explains each check. */
function diagnose(conn) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), `Testing ${conn.name} from the Jasmine runtime…`));
  const m = modal({ title: `Diagnose ${conn.name}`, body, wide: true });
  const run = async () => {
    try {
      const d = await api.post('/api/models/diagnose', { connectionId: conn.id });
      fill(body,
        d.ok ? h('div', { class: 'callout callout-success' }, icon('checkCircle'), h('div', {}, h('strong', {}, `${conn.name} is working`), h('p', {}, `Answered in ${ms(d.latencyMs)} with ${d.models.length} model(s).`)))
          : h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, `${conn.name} needs attention`), h('p', {}, 'Follow the steps below, then test again.'))),
        h('div', { class: 'where-card' }, icon(d.location.id === 'internet' ? 'cloud' : d.location.id === 'runtime' ? 'laptop' : 'server', 20), h('div', {}, h('strong', {}, `${d.baseUrl} · ${d.location.label}`), h('div', { class: 'small muted' }, d.location.detail))),
        statusList(d.checks.map((c) => ({ status: c.status, title: c.label, detail: c.detail })), { compact: true }),
        d.hints.length ? statusList(d.hints.map((hint) => ({ status: d.ok ? 'info' : 'warning', title: hint.title, steps: hint.steps })), { compact: true }) : null,
        d.models.length ? h('div', { class: 'model-chips' }, d.models.map((x) => badge(`${x.id} · ${x.capabilities.join(', ')}`, x.kind === 'embedding' ? 'info' : 'neutral'))) : null,
        h('div', {}, button('Test again', { icon: 'refresh', onClick: (e) => busy(e.currentTarget, run) })));
    } catch (e) {
      fill(body, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'The diagnosis could not run'), h('p', {}, e.message))));
    }
  };
  void run();
  return m;
}

function edit(conn, done) {
  const v = { name: conn?.name ?? '', kind: conn?.kind ?? 'ollama', baseUrl: conn?.baseUrl ?? '', apiKey: undefined, chatModel: conn?.chatModel ?? '', embeddingModel: conn?.embeddingModel ?? '', aliases: JSON.stringify(conn?.aliases ?? {}, null, 2) };
  const body = h('div', { class: 'stack' });
  const models = h('div', { class: 'muted small' });
  const draw = () => {
    const kind = KINDS.find((k) => k.value === v.kind);
    fill(body, 
      field('Name', input(v.name, (x) => (v.name = x), { placeholder: 'My Ollama' })),
      field('Type', select(KINDS.map((k) => ({ value: k.value, label: k.label })), v.kind, (x) => { v.kind = x; if (!conn) v.baseUrl = ''; draw(); }, { disabled: !!conn }), kind?.help),
      v.kind !== 'mock' ? field('Base URL', input(v.baseUrl, (x) => (v.baseUrl = x), { placeholder: kind?.url })) : null,
      v.kind !== 'mock' ? field('API key (optional)', input('', (x) => (v.apiKey = x), { type: 'password', placeholder: conn?.hasApiKey ? '•••••• (unchanged)' : 'Only if your server requires one' })) : null,
      h('div', { class: 'grid grid-2' },
        field('Default chat model', input(v.chatModel, (x) => (v.chatModel = x), { placeholder: 'auto (first chat model)' })),
        field('Default embedding model', input(v.embeddingModel, (x) => (v.embeddingModel = x), { placeholder: 'auto (first embedding model)' }))),
      conn ? h('div', {}, button('Show available models', { size: 'sm', icon: 'refresh', onClick: async () => {
        models.textContent = 'Checking…';
        const t = await api.post(`/api/models/connections/${conn.id}/test`);
        models.textContent = t.ok ? `${t.models.map((m) => m.id).join(', ') || 'No models'} (${ms(t.latencyMs)})` : `Unreachable: ${t.error}`;
      } }), models) : null,
      field('Model aliases (JSON)', textarea(v.aliases, (x) => (v.aliases = x), { mono: true, rows: 3 }), 'Map imported model names to local ones, e.g. {"gpt-4o": "llama3.1:8b"}.'));
  };
  draw();
  modal({
    title: conn ? `Edit ${conn.name}` : 'Add connection', body,
    actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: conn ? 'Save' : 'Add connection', kind: 'primary', onClick: async (close) => {
      let aliases;
      try {
        aliases = v.aliases.trim() ? JSON.parse(v.aliases) : {};
      } catch {
        return toast('Aliases must be valid JSON', 'error');
      }
      try {
        const payload = { name: v.name || KINDS.find((k) => k.value === v.kind).label, kind: v.kind, baseUrl: v.baseUrl || null, chatModel: v.chatModel || null, embeddingModel: v.embeddingModel || null, aliases, ...(v.apiKey !== undefined ? { apiKey: v.apiKey } : {}) };
        const saved = conn ? await api.put(`/api/models/connections/${conn.id}`, payload) : await api.post('/api/models/connections', payload);
        close();
        const t = await api.post(`/api/models/connections/${saved.id}/test`);
        toast(t.ok ? `Connected: ${t.models.length} model(s)` : `Saved, but unreachable: ${t.error}`, t.ok ? 'success' : 'error', 7000);
        done();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }],
  });
}

function playground(connections) {
  let connection = connections.find((c) => c.defaultChat)?.id ?? connections.find((c) => c.kind !== 'builtin')?.id ?? '';
  let model = '';
  let system = 'You are a helpful assistant.';
  let message = '';
  const out = h('div', { class: 'stack-sm' });
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Playground'), h('p', {}, 'Try a model directly before wiring it into a flow.'))),
    h('div', { class: 'grid grid-2' },
      field('Connection', select(connections.filter((c) => c.kind !== 'builtin').map((c) => ({ value: c.id, label: c.name })), connection, (v) => (connection = v))),
      field('Model', input('', (v) => (model = v), { placeholder: 'connection default' }))),
    field('System prompt', input(system, (v) => (system = v))),
    field('Message', textarea('', (v) => (message = v), { rows: 3, placeholder: 'Ask something…' })),
    h('div', {}, button('Send', { kind: 'primary', icon: 'play', onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      fill(out, h('span', { class: 'spinner' }));
      try {
        const res = await api.post('/api/models/playground', { connection, model: model || undefined, messages: [{ role: 'system', content: system }, { role: 'user', content: message }] });
        fill(out, h('div', { class: 'bubble bubble-bot', style: { maxWidth: '100%' } }, res.text), h('div', { class: 'muted small' }, `${res.connection} · ${res.model} · ${ms(res.latencyMs)} · ${res.inputTokens} in / ${res.outputTokens} out tokens`));
      } catch (err) {
        fill(out, h('div', { class: 'callout callout-danger' }, icon('alert'), err.message));
      } finally {
        btn.disabled = false;
      }
    } })), out);
}

function comparisons(connections){
  let prompt='Explain retrieval-augmented generation in one sentence.',expected='';const chosen=new Set(connections.filter(c=>c.kind!=='builtin').map(c=>c.id));const result=h('div',{class:'stack-sm'});
  return card(h('h2',{},'Compare local models'),h('p',{class:'muted'},'Measure the same prompt across connections. Optional substring checks are explicit criteria; latency and token usage are measured.'),h('div',{class:'row'},connections.filter(c=>c.kind!=='builtin').map(c=>h('label',{},h('input',{type:'checkbox',checked:true,onChange:e=>e.target.checked?chosen.add(c.id):chosen.delete(c.id)}),c.name))),field('Prompt',textarea(prompt,v=>prompt=v)),field('Expected substring (optional)',input('',v=>expected=v)),button('Run comparison',{kind:'primary',onClick:async()=>{try{result.textContent='Running…';const report=await api.post('/api/models/compare',{models:[...chosen].map(connection=>({connection})),cases:[{prompt,...(expected?{expectedSubstring:expected}:{})}]});result.replaceChildren(jsonPanel(report));}catch(e){result.textContent=e.message;}}}),result);
}
