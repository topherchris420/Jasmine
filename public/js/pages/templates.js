import { api } from '../api.js';
import { badge, button, card, emptyState, fill, h, icon, input, page, toast } from '../ui.js';

export async function render(container, _params, { navigate }) {
  const templates = await api.get('/api/templates');
  let query = '', category = 'All';
  const grid = h('div', { class: 'template-grid' });
  const count = h('span', { class: 'muted small', role: 'status' });
  const filters = h('div', { class: 'template-filters', 'aria-label': 'Template categories' });
  const categories = ['All', ...new Set(templates.map(t => t.category))];
  const create = async (template, event) => {
    const btn = event.currentTarget; btn.disabled = true; btn.textContent = 'Creating…';
    try { const flow = await api.post('/api/flows', { templateId: template.id }); navigate(`/flows/${flow.id}`); }
    catch (error) { toast(error.message, 'error'); btn.disabled = false; btn.textContent = 'Use template →'; }
  };
  const draw = () => {
    fill(filters, categories.map(value => h('button', { type: 'button', class: ['filter-pill', value === category ? 'active' : ''], 'aria-pressed': value === category, onClick: () => { category = value; draw(); } }, value)));
    const visible = templates.filter(t => (category === 'All' || t.category === category) && `${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
    count.textContent = `${visible.length} template${visible.length === 1 ? '' : 's'}`;
    fill(grid, visible.length ? visible.map(template => {
      const types = template.definition.nodes.map(n => n.data?.nodeId ?? n.type);
      const needsAI = types.some(type => /LLM|agent|ragNode|embed|classif|extract.*schema/i.test(type));
      return card(h('div', { class: 'row spread' }, h('span', { class: 'template-symbol' }, icon(template.category === 'Chat' ? 'chat' : template.category === 'RAG' ? 'context' : 'flows', 22)), badge(template.category, 'accent')),
        h('h2', {}, template.name), h('p', { class: 'muted grow' }, template.description),
        h('div', { class: 'template-meta' }, h('span', {}, `${types.length} steps`), h('span', {}, template.id === 'first-workflow' ? 'No model required' : needsAI ? 'Configure a model' : 'Check node settings')),
        button('Use template →', { onClick: event => create(template, event) }));
    }) : emptyState('search', 'No matching templates', 'Try another category or search term.'));
  };
  container.append(page('Start with a working idea.', 'Useful starting points you can open, inspect, and make your own. Review model, collection and integration settings before running.',
    [input('', value => { query = value; draw(); }, { placeholder: 'Search templates…', 'aria-label': 'Search templates' })],
    h('div', { class: 'row spread' }, filters, count), grid));
  draw();
}
