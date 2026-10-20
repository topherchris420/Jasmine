import { api } from '../api.js';
import { badge, busy, button, card, emptyState, fill, h, icon, input, page, toast } from '../ui.js';

const CATEGORY_ICON = { Chat: 'chat', RAG: 'context', Agents: 'agent', Automation: 'clock', Data: 'json', Documents: 'file', 'Getting started': 'rocket' };
const PREREQ_ICON = { model: 'models', embedding: 'vector', collection: 'database', credential: 'key', input: 'folder', runtime: 'server' };

export async function render(container, _params, { navigate }) {
  const templates = await api.get('/api/templates');
  let query = '', category = 'All', modelFreeOnly = false;
  const grid = h('div', { class: 'template-grid' });
  const count = h('span', { class: 'muted small', role: 'status' });
  const filters = h('div', { class: 'template-filters', 'aria-label': 'Template categories' });
  const categories = ['All', ...new Set(templates.map(t => t.category))];
  const create = (template, event) => busy(event.currentTarget, async () => {
    try { const flow = await api.post('/api/flows', { templateId: template.id }); navigate(`/flows/${encodeURIComponent(flow.id)}?from=template`); }
    catch (error) { toast(error.message, 'error'); }
  });
  const draw = () => {
    fill(filters,
      categories.map(value => h('button', { type: 'button', class: ['filter-pill', value === category ? 'active' : ''], 'aria-pressed': value === category, onClick: () => { category = value; draw(); } }, value)),
      h('button', { type: 'button', class: ['filter-pill', modelFreeOnly ? 'active' : ''], 'aria-pressed': modelFreeOnly, onClick: () => { modelFreeOnly = !modelFreeOnly; draw(); } }, icon('check', 12), ' Works without a model'));
    const q = query.toLowerCase();
    const visible = templates.filter(t => (category === 'All' || t.category === category) && (!modelFreeOnly || t.prerequisites?.modelFree)
      && `${t.name} ${t.description} ${t.useCase ?? ''} ${t.category}`.toLowerCase().includes(q));
    count.textContent = `${visible.length} template${visible.length === 1 ? '' : 's'}`;
    fill(grid, visible.length ? visible.map(template => {
      const prereqs = template.prerequisites?.items ?? [];
      return card(
        h('div', { class: 'row spread' }, h('span', { class: 'template-symbol' }, icon(CATEGORY_ICON[template.category] ?? 'flows', 22)), badge(template.category, 'accent')),
        h('h2', {}, template.name),
        h('p', { class: 'muted', style: { margin: 0 } }, template.useCase || template.description),
        template.input || template.output ? h('dl', { class: 'template-io' },
          template.input ? [h('dt', {}, 'You send'), h('dd', {}, template.input)] : null,
          template.output ? [h('dt', {}, 'You get'), h('dd', {}, template.output)] : null) : null,
        h('div', { class: 'stack-sm grow' }, h('div', { class: 'field-label' }, 'What it needs'),
          h('div', { class: 'prereqs' }, template.prerequisites?.modelFree && !prereqs.length
            ? badge('Nothing to set up', 'success')
            : [template.prerequisites?.modelFree ? badge('No model needed', 'success') : null, ...prereqs.map(p => h('span', { class: 'badge badge-outline' }, icon(PREREQ_ICON[p.kind] ?? 'info', 12), p.label))])),
        h('div', { class: 'template-meta' }, h('span', {}, `${template.definition.nodes.length} steps`), h('span', {}, 'Opens as a draft you can edit')),
        button('Use template →', { onClick: event => create(template, event) }));
    }) : emptyState('search', 'No matching templates', 'Try another category or search term, or describe what you want on the home page.', button('Describe it instead', { onClick: () => navigate('/') })));
  };
  container.append(page('Templates', 'A working starting point. Check the inputs, outputs and requirements, then make it yours.',
    [input('', value => { query = value; draw(); }, { placeholder: 'Search templates…', 'aria-label': 'Search templates', type: 'search' })],
    h('div', { class: 'row spread row-wrap' }, filters, count), grid));
  draw();
}
