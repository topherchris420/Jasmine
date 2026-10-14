import { api } from '../api.js';
import { badge, button, card, confirmDialog, field, fill, h, input, modal, page, select, table, timeAgo, toast } from '../ui.js';

export async function render(container, _params, { navigate }) {
  const flows = await api.get('/api/flows');
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const { rules, events } = await api.get('/api/alerts');
    fill(body,
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Rules'), button('Create rule', { icon: 'plus', kind: 'primary', onClick: () => edit(null) })),
        table([
          { label: 'Rule', render: (r) => h('strong', {}, r.name) },
          { label: 'Flow', render: (r) => r.flowId || 'All flows' },
          { label: 'Condition', render: (r) => r.kind === 'failure' ? 'Run fails' : `${r.kind === 'latency' ? 'Duration' : 'Tokens'} > ${r.threshold}${r.kind === 'latency' ? ' ms' : ''}` },
          { label: 'Status', render: (r) => badge(r.enabled ? 'enabled' : 'disabled', r.enabled ? 'success' : 'neutral') },
          { label: 'Actions', render: (r) => h('div', { class: 'row' }, button('Edit', { size: 'sm', onClick: () => edit(r) }), button('Delete', { size: 'sm', onClick: async () => { if (await confirmDialog(`Delete rule ${r.name}?`)) { await api.del(`/api/alerts/rules/${r.id}`); await draw(); } } })) },
        ], rules, { empty: h('p', { class: 'muted' }, 'Create a rule for failures, slow runs, or token usage. New runs are evaluated as they finish.') })),
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Alert inbox')),
        table([
          { label: 'When', render: (e) => timeAgo(e.createdAt) },
          { label: 'Rule', render: (e) => e.ruleName },
          { label: 'Run', render: (e) => h('a', { href: `/logs/${e.runId}`, 'data-link': '' }, `${e.flowId} →`) },
          { label: 'Observed', render: (e) => e.kind === 'failure' ? 'Run failed' : `${Math.round(e.value)}${e.kind === 'latency' ? ' ms' : ' tokens'}` },
          { label: 'Status', render: (e) => e.acknowledgedAt ? badge('acknowledged', 'neutral') : button('Acknowledge', { size: 'sm', onClick: async () => { await api.post(`/api/alerts/${e.id}/acknowledge`); await draw(); } }) },
        ], events, { empty: h('p', { class: 'muted' }, 'No alerts yet. Rules apply to future completed runs.') })));
  };
  function edit(existing) {
    const rule = existing ? { ...existing } : { name: 'Flow failure', flowId: null, kind: 'failure', threshold: 10000, enabled: true };
    modal({ title: existing ? 'Edit rule' : 'Create rule', body: h('div', { class: 'stack' },
      field('Name', input(rule.name, (v) => rule.name = v)),
      field('Flow', select([{ value: '', label: 'All flows' }, ...flows.map((f) => ({ value: f.id, label: f.name }))], rule.flowId || '', (v) => rule.flowId = v || null)),
      field('Condition', select([{ value: 'failure', label: 'Run fails' }, { value: 'latency', label: 'Duration exceeds threshold (ms)' }, { value: 'tokens', label: 'Tokens exceed threshold' }], rule.kind, (v) => rule.kind = v)),
      field('Threshold', input(String(rule.threshold), (v) => rule.threshold = Number(v), { type: 'number', min: 0 }), 'Ignored for failure rules.'),
      field('Enabled', select([{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }], String(rule.enabled), (v) => rule.enabled = v === 'true'))),
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Save rule', kind: 'primary', onClick: async (close) => {
        try { if (existing) await api.put(`/api/alerts/rules/${existing.id}`, rule); else await api.post('/api/alerts/rules', rule); close(); await draw(); } catch (e) { toast(e.message, 'error'); }
      } }] });
  }
  container.append(page('Alerts', 'A local inbox for failures, slow runs, and excessive token use. Inspect the linked trace and acknowledge alerts after review.', [button('Refresh', { onClick: draw }), button('View logs', { onClick: () => navigate('/logs') })], body));
  await draw();
}
