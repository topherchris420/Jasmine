import { api } from '../api.js';
import { composer } from '../planner.js';
import { createRunView } from '../runview.js';
import { statusList } from '../shared.js';
import { badge, busy, button, card, field, fill, h, icon, input, select, toast } from '../ui.js';

/* First-time setup: three obvious ways in. Explore runs a real model-free workflow; Connect finds and tests a
   model server from the runtime's point of view; Build starts from a description or a template. */

const PATHS = [
  { id: 'explore', icon: 'compass', title: 'Explore Jasmine', text: 'Run a working workflow right now. No downloads, no model and no keys.', cta: 'Start exploring' },
  { id: 'connect', icon: 'models', title: 'Connect my AI', text: 'Find Ollama or LM Studio, or add another provider. Jasmine tests the connection and explains any problem.', cta: 'Connect a model' },
  { id: 'build', icon: 'wand', title: 'Build something', text: 'Describe what you want in plain words, or start from a proven template.', cta: 'Start building' },
];

const PROVIDERS = [
  { id: 'ollama', kind: 'ollama', title: 'Ollama', text: 'Free, runs models on your own hardware', url: 'http://127.0.0.1:11434', name: 'Ollama' },
  { id: 'lmstudio', kind: 'openai', title: 'LM Studio', text: 'Desktop app with a local server', url: 'http://127.0.0.1:1234/v1', name: 'LM Studio' },
  { id: 'openai', kind: 'openai', title: 'Other OpenAI-compatible', text: 'llama.cpp, vLLM, LocalAI or a hosted provider', url: '', name: 'My model server' },
  { id: 'mock', kind: 'mock', title: 'Demo responses', text: 'No model; deterministic text for trying workflows', url: '', name: 'Demo responses' },
];

const HELP = {
  ollama: ['Install Ollama from ollama.com and open it (or run “ollama serve”).', 'Pull a chat model: ollama pull llama3.2', 'Optional, for document search: ollama pull nomic-embed-text'],
  lmstudio: ['Open LM Studio and download a model from the Discover tab.', 'In the Developer tab, load the model and press Start Server.', 'Keep the server running while you use Jasmine.'],
  openai: ['Use the API base address, including /v1.', 'Paste an API key only if your provider requires one. It is encrypted on the runtime.'],
};

export async function render(container, _params, { navigate, query }) {
  const setup = await api.get('/api/setup');
  let name = setup.project.name;
  let path = PATHS.some((p) => p.id === query.get('path')) ? query.get('path') : null;
  const panel = h('div', { class: 'stack-lg' });
  const cards = h('div', { class: 'path-cards', role: 'group', 'aria-label': 'Choose how to start' });
  const choose = (id) => {
    path = id;
    history.replaceState(null, '', `/setup?path=${id}`);
    drawCards();
    void drawPanel();
    panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  const drawCards = () => fill(cards, PATHS.map((p) => h('button', { type: 'button', class: 'path-card', 'aria-pressed': path === p.id ? 'true' : 'false', 'aria-controls': 'setup-panel', onClick: () => choose(p.id) },
    h('span', { class: 'tile-icon' }, icon(p.icon, 22)), h('h2', {}, p.title), h('p', {}, p.text), h('span', { class: 'path-foot' }, p.cta, icon('arrowRight', 15)))));

  const drawPanel = async () => {
    if (!path) return fill(panel);
    // Choosing a path ends the welcome screen: Home opens next time, and Getting started stays in the menu.
    if (!setup.complete) {
      setup.complete = true;
      void Promise.resolve(api.put('/api/setup', { complete: true })).catch(() => { setup.complete = false; });
    }
    fill(panel, h('div', { class: 'page-loading', style: { height: '120px' } }, h('span', { class: 'spinner' })));
    try {
      fill(panel, path === 'explore' ? await explore(navigate) : path === 'connect' ? await connect(query, () => choose('build')) : await build(navigate));
    } catch (e) {
      fill(panel, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'This step could not load'), h('p', {}, e.message))));
    }
  };

  const projectStatus = h('span', { class: 'small muted', role: 'status' });
  container.append(h('div', { class: 'page page-narrow' },
    h('header', { class: 'stack-sm' },
      h('span', { class: 'eyebrow' }, 'Getting started'),
      h('h1', {}, 'Welcome to Jasmine'),
      h('p', { class: 'lede' }, 'Describe what you want to build. Jasmine helps you turn it into something that works, and shows you every step it takes.')),
    cards,
    h('div', { id: 'setup-panel' }, panel),
    card(h('div', { class: 'row row-wrap', style: { alignItems: 'flex-end' } },
      h('div', { class: 'grow', style: { minWidth: '220px' } }, field('Workspace name', input(name, (v) => (name = v), { placeholder: 'My workspace', maxLength: 100 }), 'Shown in the sidebar and on your hosted pages.')),
      button('Save name', { onClick: async (e) => busy(e.currentTarget, async () => { try { await api.put('/api/setup', { name }); projectStatus.textContent = 'Saved'; toast('Workspace named', 'success'); } catch (err) { projectStatus.textContent = err.message; } }) }), projectStatus)),
    h('div', { class: 'setup-footer' }, h('p', { class: 'muted' }, 'You can come back to this guide at any time from Getting started.'),
      button('Go to my workspace', { kind: 'primary', icon: 'arrowRight', onClick: async () => { try { await api.put('/api/setup', { name, complete: true }); location.assign('/'); } catch (error) { toast(error.message, 'error'); } } }))));
  drawCards();
  await drawPanel();
}

/* ---------------- Explore ---------------- */

async function explore(navigate) {
  const firstOut = h('div', { class: 'stack' });
  const chatOut = h('div', { class: 'stack' });
  const runFirst = async (btn) => busy(btn, async () => {
    try {
      const flows = await api.get('/api/flows');
      const flow = flows.find((f) => f.id === 'your-first-api') ?? await api.post('/api/flows', { templateId: 'first-workflow' });
      const view = createRunView({ steps: [{ id: 'request', name: 'Receive a message' }, { id: 'response', name: 'Return JSON' }] });
      fill(firstOut, view.el);
      const started = await api.post(`/api/flows/${encodeURIComponent(flow.id)}/test`, { payload: { message: 'Hello, Jasmine' } });
      view.start(started.requestId);
      view.onFinish((result) => {
        firstOut.append(result?.status === 'success'
          ? h('div', { class: 'callout callout-success' }, icon('checkCircle'), h('div', {}, h('strong', {}, 'That was a real run.'), h('p', {}, 'Jasmine’s engine received your message and returned JSON. No AI model was involved. Next, open it in the builder, change the response, and deploy it as an API.'),
            h('div', { class: 'row row-wrap', style: { marginTop: '8px' } }, button('Open in the builder', { kind: 'primary', icon: 'edit', onClick: () => navigate(`/flows/${encodeURIComponent(flow.id)}`) }), button('See the full trace', { kind: 'ghost', onClick: () => navigate(`/logs/${view.requestId}`) }))))
          : null);
      });
    } catch (e) {
      fill(firstOut, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'Could not run the example'), h('p', {}, e.message))));
    }
  });
  const runChat = async (btn) => busy(btn, async () => {
    try {
      const models = await api.get('/api/models');
      const real = models.find((m) => m.ok && m.kind !== 'mock' && m.kind !== 'builtin' && m.models.some((x) => x.kind === 'chat'));
      let note;
      const flow = await api.post('/api/flows', { templateId: 'getting-started', name: 'Demo chat assistant' });
      if (real) note = `Your connected model, ${real.name}, will answer.`;
      else {
        // Only this demo workflow uses demo responses; the workspace's default model stays as it is.
        const { connections } = await api.get('/api/models/connections');
        const demo = connections.find((c) => c.kind === 'mock') ?? await api.post('/api/models/connections', { name: 'Demo responses', kind: 'mock' });
        const saved = await api.get(`/api/flows/${encodeURIComponent(flow.id)}`);
        for (const n of saved.definition?.nodes ?? []) if (n.data?.nodeId === 'LLMNode') n.data.values = { ...n.data.values, generativeModelName: { connection: demo.id } };
        await api.put(`/api/flows/${encodeURIComponent(flow.id)}`, { name: saved.name, definition: saved.definition, expectedRevision: saved.revision });
        note = 'This demo uses demo responses: they echo your message so you can see each step work. No AI model runs, and your other workflows are not affected.';
      }
      fill(chatOut, h('div', { class: real ? 'callout callout-success' : 'demo-note' }, icon(real ? 'checkCircle' : 'info', 15), h('span', {}, note)),
        button('Open the chat test', { kind: 'primary', icon: 'chat', onClick: () => navigate(`/flows/${encodeURIComponent(flow.id)}?panel=test`) }));
    } catch (e) {
      fill(chatOut, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'Could not set up the demo'), h('p', {}, e.message))));
    }
  });
  return h('div', { class: 'stack-lg' },
    card(h('div', { class: 'stack' },
      h('div', { class: 'row' }, badge('1', 'accent'), h('h2', {}, 'Run a real workflow, no model needed')),
      h('p', { class: 'muted', style: { margin: 0 } }, '“Your First API” receives a message and returns structured JSON. Watch each step run; this is the same engine that runs your deployed workflows.'),
      h('div', {}, button('Create and run it', { kind: 'primary', icon: 'play', onClick: (e) => runFirst(e.currentTarget) })), firstOut)),
    card(h('div', { class: 'stack' },
      h('div', { class: 'row' }, badge('2', 'accent'), h('h2', {}, 'Chat with a demo assistant')),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Opens a chat workflow you can talk to in the builder. Without a connected model it uses demo responses that echo your message. They show how chat history and replies flow; they are not real AI inference.'),
      h('div', {}, button('Try the chat demo', { icon: 'chat', onClick: (e) => runChat(e.currentTarget) })), chatOut)));
}

/* ---------------- Connect ---------------- */

async function connect(query, next) {
  const hosting = await api.get('/api/hosting').catch(() => ({ mode: 'direct' }));
  const localPage = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const hosted = hosting.mode === 'vercel-gateway' || !localPage;
  let provider = PROVIDERS.find((p) => p.id === (query.get('kind') === 'openai' ? 'openai' : query.get('kind'))) ?? null;
  let baseUrl = provider?.url ?? '';
  let apiKey = '';
  let chatModel = '';
  let diagnosis = null;
  const found = h('div', { class: 'stack-sm' });
  const form = h('div', { class: 'stack' });
  const result = h('div', { class: 'stack' });
  const providers = h('div', { class: 'provider-grid', role: 'group', 'aria-label': 'Model provider' });
  let testButton = null;

  const drawProviders = () => fill(providers, PROVIDERS.map((p) => h('button', { type: 'button', class: 'provider', 'aria-pressed': provider?.id === p.id ? 'true' : 'false', onClick: () => { provider = p; baseUrl = p.url; diagnosis = null; fill(result); drawProviders(); drawForm(); } }, h('strong', {}, p.title), h('span', {}, p.text))));

  const save = async (btn, { tested }) => busy(btn, async () => {
    try {
      const payload = { name: provider.name, kind: provider.kind, ...(provider.kind !== 'mock' ? { baseUrl: baseUrl || provider.url || null, chatModel: chatModel || diagnosis?.suggested?.chatModel || null, embeddingModel: diagnosis?.suggested?.embeddingModel ?? null } : {}), ...(apiKey ? { apiKey } : {}) };
      const saved = await api.post('/api/models/connections', payload);
      apiKey = '';
      for (const el of form.querySelectorAll('input[type=password]')) el.value = '';
      const embedding = provider.kind === 'mock' || diagnosis?.suggested?.embeddingModel;
      await api.put('/api/models/defaults', { chat: saved.id, ...(embedding && provider.kind !== 'mock' ? { embedding: saved.id } : {}) });
      fill(result, provider.kind === 'mock'
        ? h('div', { class: 'demo-note' }, icon('info', 15), h('span', {}, 'Demo responses are ready. Responses are deterministic; no AI model runs.'))
        : h('div', { class: tested ? 'callout callout-success' : 'callout callout-warning' }, icon(tested ? 'checkCircle' : 'alert'), h('div', {},
          h('strong', {}, tested ? `${saved.name} is connected` : `${saved.name} is saved, but not working yet`),
          h('p', {}, tested ? `New workflows use ${saved.chatModel ?? 'its default model'} unless a step picks another.${saved.embeddingModel ? ` Document search uses ${saved.embeddingModel}.` : ''}` : 'Fix the problems above and test again under Models.'))),
        button('Build something with it', { kind: 'primary', icon: 'wand', onClick: next }));
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  const test = async (btn) => busy(btn, async () => {
    fill(result, h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), 'Testing from the Jasmine runtime…'));
    try {
      diagnosis = await api.post('/api/models/diagnose', { kind: provider.kind, baseUrl: baseUrl || provider.url, ...(apiKey ? { apiKey } : {}) });
      const chats = diagnosis.models.filter((m) => m.kind === 'chat');
      chatModel = chats.some((m) => m.id === chatModel) ? chatModel : diagnosis.suggested.chatModel ?? '';
      fill(result,
        h('div', { class: 'where-card' }, icon(diagnosis.location.id === 'internet' ? 'cloud' : diagnosis.location.id === 'runtime' ? 'laptop' : 'server', 20), h('div', {}, h('strong', {}, diagnosis.location.label), h('div', { class: 'small muted' }, diagnosis.location.detail))),
        statusList(diagnosis.checks.map((c) => ({ status: c.status, title: c.label, detail: c.detail })), { compact: true }),
        diagnosis.hints.length ? statusList(diagnosis.hints.map((hint) => ({ status: diagnosis.ok ? 'info' : 'warning', title: hint.title, steps: hint.steps })), { compact: true }) : null,
        chats.length ? field('Chat model for new workflows', select(chats.map((m) => ({ value: m.id, label: `${m.id}${m.capabilities.includes('vision') ? ' · vision' : ''}` })), chatModel, (v) => (chatModel = v))) : null,
        diagnosis.models.length ? h('div', { class: 'model-chips' }, diagnosis.models.map((m) => badge(`${m.id} · ${m.capabilities.join(', ')}`, m.kind === 'embedding' ? 'info' : 'neutral'))) : null,
        h('div', { class: 'row row-wrap' },
          diagnosis.ok ? button('Save and use this connection', { kind: 'primary', icon: 'check', onClick: (e) => save(e.currentTarget, { tested: true }) }) : button('Test again', { kind: 'primary', icon: 'refresh', onClick: (e) => test(e.currentTarget) }),
          diagnosis.ok ? null : button('Save it anyway', { kind: 'ghost', onClick: (e) => save(e.currentTarget, { tested: false }) })));
    } catch (e) {
      fill(result, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'The test could not run'), h('p', {}, e.message))));
    }
  });

  const drawForm = () => {
    testButton = null;
    if (!provider) return fill(form);
    if (provider.kind === 'mock') {
      return fill(form, h('div', { class: 'demo-note' }, icon('info', 15), h('span', {}, 'Demo responses echo prompts and fill structured fields with placeholders. Use them to try workflows; they perform no AI inference.')),
        h('div', {}, button('Enable demo responses', { kind: 'primary', icon: 'play', onClick: (e) => save(e.currentTarget, { tested: true }) })));
    }
    fill(form,
      HELP[provider.id] ? h('ol', { class: 'setup-instructions', style: { margin: 0 } }, HELP[provider.id].map((t) => h('li', { style: { margin: '6px 0' } }, t))) : null,
      field('Server address', input(baseUrl, (v) => (baseUrl = v), { type: 'url', placeholder: provider.url || 'https://your-provider.example/v1', autocomplete: 'off', spellcheck: 'false' }), hosted ? 'This address must be reachable from the Jasmine runtime, not just from your browser.' : 'On this computer, the default address usually works.'),
      provider.id === 'ollama' ? null : field('API key (optional)', input(apiKey, (v) => (apiKey = v), { type: 'password', autocomplete: 'off', placeholder: 'Only if your server requires one' }), 'Encrypted on the runtime. Studio never shows it again.'),
      h('div', {}, testButton = button('Test connection', { kind: 'primary', icon: 'refresh', onClick: (e) => test(e.currentTarget) })));
  };

  const discover = async (btn) => busy(btn, async () => {
    fill(found, h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), 'Looking for model servers on the usual ports…'));
    try {
      const { servers } = await api.post('/api/models/discover', {});
      const ok = servers.filter((s) => s.ok);
      fill(found, ok.length ? ok.map((s) => h('div', { class: 'found-server' }, icon('checkCircle', 18), h('div', { class: 'grow' }, h('strong', {}, `${s.label} at ${s.baseUrl}`),
        h('div', { class: 'small muted' }, s.models.length ? `${s.models.length} model(s): ${s.models.slice(0, 4).map((m) => m.id).join(', ')}` : 'Running, but no models are installed yet.')),
        button(s.connectionId ? 'Test it' : 'Use this server', { size: 'sm', kind: 'primary', onClick: () => {
          provider = s.kind === 'ollama' ? PROVIDERS[0] : /:1234\b/.test(s.baseUrl) ? PROVIDERS[1] : PROVIDERS[2];
          baseUrl = s.baseUrl;
          drawProviders();
          drawForm();
          if (testButton) void test(testButton);
        } })))
        : h('div', { class: 'callout' }, icon('info'), h('div', {}, h('strong', {}, 'No model server answered on the usual ports'), h('p', {}, hosted ? 'That is expected for a hosted runtime unless a model server runs next to it. Choose a provider below and enter its address.' : 'Start Ollama or LM Studio, then search again, or choose a provider below.'))));
    } catch (e) {
      fill(found, h('div', { class: 'callout callout-danger' }, icon('alert'), e.message));
    }
  });

  drawProviders();
  drawForm();
  return card(h('div', { class: 'stack-lg' },
    h('div', { class: 'where-card' }, icon(hosted ? 'cloud' : 'laptop', 22), h('div', {},
      h('strong', {}, hosted ? 'Jasmine’s engine runs on a server' : 'Jasmine is running on this computer'),
      h('p', { class: 'small muted', style: { margin: '2px 0 0' } }, hosted
        ? 'Model requests come from the runtime, not your browser, so “localhost” means the runtime server. A model on your laptop is not reachable unless it is exposed to the runtime’s network. A hosted OpenAI-compatible provider works over HTTPS.'
        : 'Model servers on this computer are reachable at localhost, for example Ollama on port 11434 and LM Studio on port 1234.'))),
    h('div', { class: 'stack-sm' }, h('div', { class: 'row spread row-wrap' }, h('h2', {}, 'Find model servers'), button('Search the runtime’s network', { icon: 'search', onClick: (e) => discover(e.currentTarget) })), found),
    h('div', { class: 'stack' }, h('h2', {}, 'Or choose a provider'), providers, form, result)));
}

/* ---------------- Build ---------------- */

async function build(navigate) {
  const templates = await api.get('/api/templates');
  const picks = ['first-workflow', 'getting-started', 'knowledge-qa', 'support-router', 'structured-extraction', 'daily-digest'].map((id) => templates.find((t) => t.id === id)).filter(Boolean);
  return h('div', { class: 'stack-lg' },
    card(h('div', { class: 'stack' }, h('h2', {}, 'Describe it'), composer({ navigate, autofocus: true }))),
    h('div', { class: 'stack' }, h('div', { class: 'section-head' }, h('h2', {}, 'Or start from a proven template'), h('a', { href: '/templates', 'data-link': '' }, 'All templates →')),
      h('div', { class: 'tiles' }, picks.map((t) => h('button', { type: 'button', class: 'tile', onClick: async (e) => busy(e.currentTarget, async () => { try { const flow = await api.post('/api/flows', { templateId: t.id }); navigate(`/flows/${encodeURIComponent(flow.id)}?from=template`); } catch (err) { toast(err.message, 'error'); } }) },
        h('div', { class: 'row spread' }, h('strong', {}, t.name), t.prerequisites?.modelFree ? badge('No model needed', 'success') : badge('Needs a model', 'neutral')),
        h('p', {}, t.useCase || t.description))))));
}
