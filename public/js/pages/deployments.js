import { api } from '../api.js';
import { badge, button, card, emptyState, h, num, page, statusBadge, table, timeAgo, toast } from '../ui.js';
import { lifecycleBadge, TRIGGER_LABEL, triggerChip } from '../shared.js';

export async function render(container, _params, { navigate }) {
  const [flows, schedules, report] = await Promise.all([api.get('/api/flows'), api.get('/api/schedules'), api.get('/api/reports?days=1').catch(() => null)]);
  const deployed = flows.filter((f) => f.deployedVersion);
  const disabled = flows.filter((f) => !f.deployedVersion && f.lifecycle?.state === 'disabled');
  const drafts = flows.filter((f) => !f.deployedVersion && f.lifecycle?.state !== 'disabled');
  const stats = new Map((report?.byFlow ?? []).map((r) => [r.flowId, r]));
  container.append(page('Deployments', 'Deployed workflows are live on your Jasmine runtime: callable over the API, from webhooks and widgets, and on schedules. Each deploy is an immutable version you can roll back to or disable.', [],
    table([
      { label: 'Workflow', render: (f) => h('div', {}, h('div', { class: 'cell-title' }, f.name), h('code', { class: 'cell-sub' }, f.id)) },
      { label: 'Status', render: (f) => h('div', { title: f.lifecycle?.detail ?? '' }, lifecycleBadge(f)) },
      { label: 'Trigger', render: (f) => triggerChip(f.trigger) },
      { label: 'Version', render: (f) => h('div', { class: 'row' }, h('code', {}, f.deployedVersion.slice(0, 12)), f.draftChanged ? badge('draft has changes', 'warning') : null) },
      { label: 'Deployed', render: (f) => h('span', { class: 'muted nowrap' }, timeAgo(f.deployedAt)) },
      { label: 'Runs (24 h)', class: 'num', render: (f) => {
        const s = stats.get(f.id);
        return s ? h('span', {}, num(s.runs), s.failed ? h('span', { style: { color: 'var(--danger)' } }, ` · ${s.failed} failed`) : null) : h('span', { class: 'muted' }, '0');
      } },
    ], deployed, {
      onRowClick: (f) => navigate(`/deployments/${encodeURIComponent(f.id)}`),
      empty: emptyState('deploy', 'Nothing deployed yet', 'Open a workflow, test it, and press Deploy. You review what becomes live first. Its API endpoint, webhook URL or widget code then appears here.', button('Go to workflows', { kind: 'primary', icon: 'flows', onClick: () => navigate('/flows') })),
    }),
    schedules.length ? card(h('div', { class: 'card-head' }, h('h2', {}, 'Schedules')),
      table([
        { label: 'Flow', render: (s) => h('a', { href: `/deployments/${encodeURIComponent(s.flowId)}`, 'data-link': '' }, s.flowId) },
        { label: 'Trigger', render: (s) => TRIGGER_LABEL[s.trigger] ?? s.trigger },
        { label: 'Schedule', render: (s) => h('div', {}, h('code', {}, s.expression), s.timezone ? h('span', { class: 'muted small' }, ` ${s.timezone}`) : null, s.error ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, s.error) : null) },
        { label: 'Next run', render: (s) => s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—' },
        { label: 'Last run', render: (s) => s.lastFiredAt ? h('span', { class: 'row' }, s.lastStatus ? statusBadge(s.lastStatus) : null, s.lastRunId ? h('a', { href: `/logs/${s.lastRunId}`, 'data-link': '', class: 'small' }, timeAgo(s.lastFiredAt)) : timeAgo(s.lastFiredAt)) : h('span', { class: 'muted' }, 'never') },
        { label: '', class: 'num', render: (s) => button('Run now', { size: 'sm', icon: 'play', onClick: async () => {
          const r = await api.post(`/api/schedules/${encodeURIComponent(s.flowId)}/run`);
          toast(r.requestId ? 'Run started' : 'Nothing to run', r.requestId ? 'success' : 'info');
          if (r.requestId) navigate(`/logs/${r.requestId}`);
        } }) },
      ], schedules)) : null,
    disabled.length ? card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Disabled'), h('p', {}, 'Deployed before and turned off. Their versions are kept; re-enable one from its page.'))),
      h('div', { class: 'stack-sm' }, disabled.map((f) => h('a', { href: `/deployments/${encodeURIComponent(f.id)}`, 'data-link': '', class: 'attention-item', style: { color: 'inherit', textDecoration: 'none' } }, h('strong', { class: 'grow' }, f.name), lifecycleBadge(f))))) : null,
    drafts.length ? card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Not deployed yet'), h('p', {}, 'Drafts and validated workflows run only from the builder\'s Test panel.'))),
      h('div', { class: 'stack-sm' }, drafts.map((f) => h('a', { href: `/flows/${encodeURIComponent(f.id)}`, 'data-link': '', class: 'attention-item', style: { color: 'inherit', textDecoration: 'none' } }, h('strong', { class: 'grow' }, f.name), h('span', { class: 'small muted truncate', style: { maxWidth: '50%' } }, f.lifecycle?.detail ?? ''), lifecycleBadge(f))))) : null));
}
