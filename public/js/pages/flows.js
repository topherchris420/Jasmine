import { api } from '../api.js';
import { triggerChip } from '../shared.js';
import { badge, button, confirmDialog, emptyState, fill, h, icon, input, modal, page, table, tabs, textarea, timeAgo, toast } from '../ui.js';

export async function render(container, _params, { navigate }) {
  let flows = await api.get('/api/flows');
  const list = h('div');
  const draw = (items) => {
    fill(list, table([
      { label: 'Name', render: (f) => h('div', {}, h('div', { class: 'cell-title' }, f.name), h('div', { class: 'cell-sub' }, f.id)) },
      { label: 'Trigger', render: (f) => triggerChip(f.trigger) },
      { label: 'Status', render: (f) => f.deployedVersion ? h('span', { class: 'row' }, badge('Deployed', 'success'), f.draftChanged ? badge('Undeployed changes', 'warning') : null) : badge('Draft', 'neutral') },
      { label: 'Updated', render: (f) => h('span', { class: 'muted nowrap' }, timeAgo(f.updatedAt)) },
      { label: '', class: 'num', render: (f) => h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        button('Open', { size: 'sm', onClick: () => navigate(`/flows/${f.id}`) }),
        button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: `Delete ${f.name}`, onClick: async () => {
          if (!await confirmDialog(`Delete “${f.name}”? Its deployment, versions and chat history are removed. Run logs are kept.`, { danger: true, confirmLabel: 'Delete flow' })) return;
          await api.del(`/api/flows/${f.id}`);
          toast('Flow deleted', 'success');
          flows = await api.get('/api/flows');
          draw(flows);
        } })) },
    ], items, {
      onRowClick: (f) => navigate(`/flows/${f.id}`),
      empty: emptyState('flows', 'No flows yet', 'A flow connects a trigger (API, chat widget, webhook, schedule…) to AI, RAG and app nodes, and returns a response.', button('Create a flow', { kind: 'primary', icon: 'plus', onClick: () => openCreate(navigate) })),
    }));
  };
  const search = input('', (q) => draw(flows.filter((f) => `${f.name} ${f.id} ${(f.tags??[]).join(' ')}`.toLowerCase().includes(q.toLowerCase()))), { placeholder: 'Search flows…', style: 'max-width: 280px' });
  draw(flows);
  container.append(page('Flows', 'Visual workflows for your models, data and integrations. Build, test, deploy, and call them from the API, widgets, webhooks or schedules.',
    [search, button('Import', { icon: 'upload', onClick: () => openCreate(navigate, 'import') }), button('Create flow', { kind: 'primary', icon: 'plus', onClick: () => openCreate(navigate) })],
    list));
}

export async function openCreate(navigate, initial = 'template') {
  const templates = await api.get('/api/templates');
  const body = h('div', { class: 'stack' });
  let mode = initial;
  let close = () => {};
  const create = async (payload) => {
    const flow = await api.post('/api/flows', payload);
    close();
    navigate(`/flows/${flow.id}`);
  };
  const views = {
    template: () => h('div', { class: 'tiles' }, templates.map((t) => h('button', { type: 'button', class: 'tile', onClick: () => create({ templateId: t.id }).catch((e) => toast(e.message, 'error')) },
      h('div', { class: 'row spread' }, h('span', { class: 'tile-icon' }, icon(t.category === 'RAG' ? 'rag' : t.category === 'Chat' ? 'chat' : t.category === 'Agents' ? 'agent' : t.category === 'Automation' ? 'clock' : 'flows', 18)), badge(t.category, 'accent')),
      h('h3', {}, t.name), h('p', {}, t.description)))),
    blank: () => {
      let name = '';
      const field = input('', (v) => (name = v), { placeholder: 'e.g. Support assistant' });
      setTimeout(() => field.focus());
      return h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Flow name'), field),
        h('div', {}, button('Create blank flow', { kind: 'primary', icon: 'plus', onClick: () => create({ name: name || 'Untitled flow' }).catch((e) => toast(e.message, 'error')) })));
    },
    import: () => {
      let text = '';
      const refs = {};
      const area = textarea('', (v) => (text = v), { mono: true, rows: 10, placeholder: 'Paste a flow export (JSON) or an AgentKit flow module (export const nodes = [...])' });
      const status = h('div', { class: 'muted small' });
      const readFiles = async (files) => {
        for (const file of files) {
          const content = await file.text();
          const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
          if (/\/flows\/[^/]+\.(ts|json)$/.test(`/${rel}`) || (!text && /\.(json|ts)$/.test(file.name) && /nodes/.test(content))) {
            if (/export\s+const\s+nodes|"nodes"\s*:/.test(content)) {
              text = content;
              area.value = content;
              continue;
            }
          }
          const m = /(prompts|scripts|model-configs|constitutions|tools|triggers|memory)\/(.+)$/.exec(rel);
          if (m) refs[`@${m[1]}/${m[2]}`] = content;
        }
        status.textContent = `${text ? 'Flow loaded' : 'No flow file found yet'} · ${Object.keys(refs).length} kit file(s) for @references`;
      };
      const fileInput = h('input', { type: 'file', accept: '.json,.ts,.md,.js', multiple: true, class: 'hidden', onChange: (e) => readFiles([...e.target.files]) });
      const folderInput = h('input', { type: 'file', webkitdirectory: '', multiple: true, class: 'hidden', onChange: (e) => readFiles([...e.target.files]) });
      return h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Import a Studio JSON export or a flow from an AgentKit kit. Pick the whole kit folder to resolve @prompts and @scripts references automatically; cloud model settings are mapped to your local models.'),
        h('div', { class: 'row' }, button('Choose files', { icon: 'file', onClick: () => fileInput.click() }), button('Choose kit folder', { icon: 'folder', onClick: () => folderInput.click() }), fileInput, folderInput),
        area, status,
        h('div', {}, button('Import flow', { kind: 'primary', icon: 'upload', onClick: async () => {
          try {
            const res = await api.post('/api/flows/import', { text, refs });
            close();
            const errors = res.validation.diagnostics.filter((d) => d.severity === 'error').length;
            toast(errors ? `Imported with ${errors} issue(s) to fix before deploying` : 'Flow imported', errors ? 'info' : 'success');
            navigate(`/flows/${res.flow.id}`);
          } catch (e) {
            toast(e.message, 'error');
          }
        } })));
    },
  };
  const draw = () => {
    fill(body, tabs([{ id: 'template', label: 'From template', icon: 'sparkles' }, { id: 'blank', label: 'Blank', icon: 'plus' }, { id: 'import', label: 'Import', icon: 'upload' }], mode, (m) => { mode = m; draw(); }), views[mode]());
  };
  draw();
  close = modal({ title: 'Create a flow', body, wide: true }).close;
}
