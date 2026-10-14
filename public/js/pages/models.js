import { api } from '../api.js';
import { badge, button, card, confirmDialog, field, fill, h, icon, input, modal, ms, page, select, textarea, toast } from '../ui.js';

const KINDS = [
  { value: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434', help: 'Native Ollama API. Pull models with `ollama pull llama3.2` and `ollama pull nomic-embed-text`.' },
  { value: 'openai', label: 'OpenAI-compatible server', url: 'http://127.0.0.1:1234/v1', help: 'LM Studio, llama.cpp (llama-server), vLLM, LocalAI, Jan, text-generation-webui… The URL includes /v1.' },
  { value: 'mock', label: 'Mock (deterministic, for testing)', url: '', help: 'Echoes prompts back. Useful for building flows without a model server.' },
];

export async function render(container) {
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
          c.kind === 'builtin' ? h('p', { class: 'muted small' }, 'Feature-hashing embeddings that need no server. They match shared words, not meaning; use a real embedding model for semantic search.') : h('div', { class: 'row' },
            button('Edit', { size: 'sm', icon: 'edit', onClick: () => edit(c, draw) }),
            button('Delete', { size: 'sm', kind: 'ghost', icon: 'trash', onClick: async () => {
              if (!await confirmDialog(`Delete the ${c.name} connection? Nodes pinned to it fall back to the default connection.`, { danger: true, confirmLabel: 'Delete' })) return;
              await api.del(`/api/models/connections/${c.id}`);
              void draw();
            } })));
      })),
      playground(connections));
  };
  container.append(page('Models', 'Local inference servers that run your flows. Nothing is sent to a cloud model unless you point a connection at one.', [button('Refresh status', { icon: 'refresh', onClick: () => void draw() })], body));
  await draw();
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
