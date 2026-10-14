import { api, catalog } from '../api.js';
import { badge, button, confirmDialog, debounce, field, fill, h, icon, input, modal, page, timeAgo, toast } from '../ui.js';
import { nodeIcon } from '../shared.js';

/** Built-in app nodes that work without stored credentials. */
const NO_CREDENTIALS = ['apiNode', 'scraperNode', 'crawlerNode', 'firecrawlNode', 'rssNode', 'tablesNode', 'extractFromFileNode', 'flowNode', 'codeNode'];

export async function render(container) {
  const body = h('div', { class: 'stack' });
  let filter = '';
  const search = h('div', { class: 'search-box', style: { maxWidth: '360px' } }, icon('search', 14), input('', debounce((v) => { filter = v; void draw(); }, 150), { placeholder: 'Search integrations', 'aria-label': 'Search integrations' }));
  const draw = async () => {
    const [{ integrations, credentials }, cat] = await Promise.all([api.get('/api/integrations'), catalog()]);
    const q = filter.trim().toLowerCase();
    const visible = integrations.filter((i) => !q || `${i.label} ${i.description} ${i.id}`.toLowerCase().includes(q));
    const builtins = NO_CREDENTIALS.map((t) => cat.byType.get(t)).filter((s) => s && (!q || `${s.label} ${s.description}`.toLowerCase().includes(q)));
    fill(body, 
      h('h2', {}, 'Connected apps'),
      h('p', { class: 'muted' }, 'Credentials are encrypted at rest with the project key and never sent back to the browser. Nodes pick a credential by name; with a single credential for an app, it is used automatically.'),
      visible.length ? h('div', { class: 'tiles' }, visible.map((i) => integrationCard(i, credentials.filter((c) => c.integration === i.id), cat, draw))) : h('p', { class: 'muted' }, 'No matching integrations.'),
      h('h2', {}, 'Built-in tools'),
      h('p', { class: 'muted' }, 'These run locally and need no account: add them from the node palette in any flow.'),
      h('div', { class: 'tiles' }, builtins.map((s) => h('div', { class: 'card stack-sm' },
        h('div', { class: 'row' }, nodeIcon(s, 30), h('h3', { class: 'grow' }, s.label)),
        h('div', { class: 'muted small' }, s.description)))),
    );
  };
  container.append(page('Integrations', 'Connect Jasmine to the apps and services your flows talk to: chat tools, email, databases, storage, MCP servers, and more.', [], search, body));
  await draw();
}

function integrationCard(integration, creds, cat, refresh) {
  const spec = cat.byType.get(integration.nodes[0]);
  const nodeLabels = integration.nodes.map((t) => cat.byType.get(t)).filter((s) => s && !s.hidden).map((s) => s.label);
  return h('div', { class: 'card stack-sm' },
    h('div', { class: 'row' }, nodeIcon(spec ?? { icon: integration.icon, category: 'app' }, 30),
      h('h3', { class: 'grow' }, integration.label),
      creds.length ? badge(`${creds.length} connected`, 'success') : badge('not connected', 'neutral')),
    h('div', { class: 'muted small' }, integration.description),
    nodeLabels.length ? h('div', { class: 'muted small' }, `Nodes: ${nodeLabels.join(', ')}`) : null,
    creds.length ? h('div', { class: 'stack-sm' }, creds.map((c) => h('div', { class: 'cred-row row' },
      icon('key', 14), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, c.name), h('div', { class: 'muted small' }, `${c.fields.join(', ') || 'no fields'} · updated ${timeAgo(c.updatedAt)}`)),
      button('', { icon: 'edit', kind: 'ghost', size: 'sm', title: 'Edit credential', onClick: () => editCredential(integration, c, refresh) }),
      button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete credential', onClick: async () => {
        if (!await confirmDialog(`Delete the "${c.name}" ${integration.label} credential? Flows that use it will fail until they get another one.`, { danger: true, confirmLabel: 'Delete' })) return;
        await api.del(`/api/credentials/${c.id}`);
        toast('Credential deleted', 'success');
        void refresh();
      } })))) : null,
    h('div', {}, button(creds.length ? 'Add another' : 'Connect', { size: 'sm', icon: 'plus', kind: creds.length ? 'secondary' : 'primary', onClick: () => editCredential(integration, null, refresh) })));
}

function editCredential(integration, existing, refresh) {
  const values = {};
  let name = existing?.name ?? (integration.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'default');
  const fields = integration.fields ?? [];
  const body = h('div', { class: 'stack' },
    field('Credential name', input(name, (v) => (name = v)), 'Nodes refer to the credential by this name.'),
    ...fields.map((f) => field(f.label, input('', (v) => (values[f.key] = v), {
      type: f.secret ? 'password' : 'text', autocomplete: 'off',
      placeholder: existing?.fields.includes(f.key) ? '•••••• (unchanged)' : (f.placeholder ?? ''),
    }))),
    existing ? h('p', { class: 'muted small' }, 'Leave a field empty to keep its stored value.') : null);
  modal({
    title: existing ? `Edit ${integration.label} credential` : `Connect ${integration.label}`, body,
    actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: existing ? 'Save' : 'Connect', kind: 'primary', icon: 'check', onClick: async (close) => {
      try {
        const payload = { integration: integration.id, name, data: values };
        if (existing) await api.put(`/api/credentials/${existing.id}`, payload);
        else await api.post('/api/credentials', payload);
        close();
        toast(`${integration.label} credential saved`, 'success');
        void refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }],
  });
}
