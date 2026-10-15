import { api } from '../api.js';
import { badge, button, card, field, fill, h, icon, input, page, select, toast } from '../ui.js';

export async function render(container, _params, { navigate }) {
  const setup = await api.get('/api/setup');
  let name = setup.project.name;
  const projectStatus = h('span', { class: 'small muted', role: 'status' });
  const connectionStatus = h('div', { class: 'small muted', role: 'status' });
  const modelFields = h('div', { class: 'stack' });
  let endpoint = '', apiKey = '', model = '', kind = 'openai';
  const modelChoice = h('div');
  let chosenConnection = '';
  const connect = async event => {
    const btn = event.currentTarget;
    btn.disabled = true; connectionStatus.textContent = 'Saving and testing connection…';
    try {
      const saved = await api.post('/api/models/connections', { name: kind === 'mock' ? 'Demo responses' : 'My model', kind, ...(kind !== 'mock' ? { baseUrl: endpoint, apiKey, chatModel: model || null } : {}) });
      chosenConnection = saved.id;
      const tested = await api.post(`/api/models/connections/${saved.id}/test`);
      if (!tested.ok) throw new Error(`Connection saved, but the server could not be reached: ${tested.error}. Edit it under Models or try again here.`);
      await api.put('/api/models/defaults', { chat: saved.id });
      connectionStatus.textContent = kind === 'mock' ? 'Demo mode is ready. Responses are deterministic; no AI model runs.' : 'Connected. Choose the model you want to use below.';
      apiKey = ''; const passwordField = modelFields.querySelector('input[type=password]'); if (passwordField) passwordField.value = '';
      const models = tested.models.filter(m => m.kind === 'chat');
      if (models.length) fill(modelChoice, field('Chat model', select(models.map(m => ({ value: m.id, label: m.id })), model || models[0].id, async value => {
        model = value; await api.put(`/api/models/connections/${chosenConnection}`, { ...saved, chatModel: model }); toast('Model selected', 'success');
      })));
      if (!model && models.length) { model = models[0].id; await api.put(`/api/models/connections/${saved.id}`, { ...saved, chatModel: model }); }
    } catch (error) { connectionStatus.textContent = error.message; }
    finally { btn.disabled = false; }
  };
  const drawFields = () => fill(modelFields,
    field('Connection type', select([{ value: 'openai', label: 'OpenAI-compatible API (hosted or self-hosted)' }, { value: 'ollama', label: 'Ollama on the runtime network' }, { value: 'mock', label: 'Demo responses — no AI model' }], kind, value => { kind = value; drawFields(); })),
    kind !== 'mock' ? field('Model server URL', input(endpoint, value => endpoint = value, { placeholder: kind === 'ollama' ? 'http://ollama:11434' : 'https://your-provider.example/v1', type: 'url' }), 'This must be reachable from the Jasmine runtime.') : null,
    kind !== 'mock' ? field('Provider API key', input(apiKey, value => apiKey = value, { type: 'password', autocomplete: 'off', placeholder: 'Required only by your provider' })) : null,
    kind !== 'mock' ? field('Model ID (optional)', input(model, value => model = value, { placeholder: 'Choose from discovered models after connecting' })) : null,
    button(kind === 'mock' ? 'Enable demo responses' : 'Connect and test', { kind: 'primary', icon: 'integrations', onClick: connect }), modelChoice, connectionStatus);
  drawFields();
  const firstStatus = h('div', { class: 'small muted', role: 'status' });
  const firstFlow = async event => {
    event.currentTarget.disabled = true;
    try {
      const flow = await api.post('/api/flows', { templateId: 'first-workflow' });
      navigate(`/flows/${flow.id}`);
    } catch (error) { firstStatus.textContent = error.message; event.currentTarget.disabled = false; }
  };
  container.append(page('Make something that works.', 'From your first request to an application you can share. Start small, then add intelligence.', [],
    h('div', { class: 'setup-intro' }, badge('GETTING STARTED', 'accent'), h('p', {}, 'A workspace for your models, your knowledge, and the connections between them.')),
    h('div', { class: 'setup-grid' },
      card(h('span', { class: 'step-number' }, '01'), h('h2', {}, 'Make it yours'), h('p', { class: 'muted' }, 'Give your workspace a name you will recognize.'),
        field('Workspace name', input(name, value => name = value, { placeholder: 'My workspace', maxLength: 100 })),
        button('Save workspace', { onClick: async () => { try { await api.put('/api/setup', { name }); projectStatus.textContent = 'Saved'; toast('Workspace named', 'success'); } catch (error) { projectStatus.textContent = error.message; } } }), projectStatus),
      card(h('span', { class: 'step-number' }, '02'), h('h2', {}, 'Connect your intelligence'), h('p', { class: 'muted' }, setup.connections ? 'You already have a connection. Manage it in Models, or add another here.' : 'Bring a hosted provider or a model server you control. You can also do this later.'), modelFields),
      card(h('span', { class: 'step-number' }, '03'), h('h2', {}, 'Ship your first flow'), h('p', { class: 'muted' }, 'Your First API returns real JSON without needing a model. Learn the canvas, then build from there.'),
        h('ol', { class: 'setup-instructions' }, h('li', {}, 'Create the flow and open Test.'), h('li', {}, 'Send a message and inspect the output.'), h('li', {}, 'Deploy, then copy the API endpoint from Deployments.')),
        button('Create my first API', { kind: 'primary', icon: 'play', onClick: firstFlow }), firstStatus,
        h('a', { href: '/templates', 'data-link': '', class: 'small' }, 'Or explore every template →'))),
    h('div', { class: 'setup-footer' }, h('p', { class: 'muted' }, 'You can return to this guide at any time.'),
      button('Go to my workspace', { kind: 'primary', onClick: async () => { try { await api.put('/api/setup', { name, complete: true }); location.assign('/'); } catch (error) { toast(error.message, 'error'); } } }))));
}
