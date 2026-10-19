import { api } from '../api.js';
import { statusList } from '../shared.js';
import { badge, busy, button, fill, h, icon, jsonPanel, textarea, timeAgo, toast } from '../ui.js';

const ACTIONS = [
  { id: 'diagnose', label: 'Why isn’t this working?', icon: 'alert' },
  { id: 'explain', label: 'Explain this workflow', icon: 'info' },
  { id: 'connect', label: 'Help me connect my model', icon: 'models' },
  { id: 'faster', label: 'Make it faster', icon: 'bolt' },
  { id: 'add-retrieval', label: 'Add document retrieval', icon: 'rag' },
  { id: 'capabilities', label: 'What can I build?', icon: 'sparkles' },
];

/**
 * The builder's copilot. Answers come from Jasmine's own checks of this workspace, plus your connected model when
 * there is one. Suggested edits are shown as a diff and applied only when you approve; every applied change is
 * recorded and can be reverted. The copilot never runs, deploys or publishes anything.
 */
export function assistantPanel({ flowId, nodeId, prepare, onApplied, onSelectNode, getRevision, nameOf = (id) => id }) {
  const history = [];
  const log = h('div', { class: 'stack', role: 'log', 'aria-live': 'polite', 'aria-label': 'Copilot conversation' });
  const historyBox = h('div', { class: 'stack-sm' });
  let message = '';
  let busyNow = false;
  const area = textarea('', (v) => (message = v), { rows: 3, placeholder: nodeId ? `Ask about “${nameOf(nodeId)}”, or describe a change…` : 'Ask about this workflow, or describe a change…' });
  area.setAttribute('aria-label', 'Message to the copilot');

  const findingsView = (findings) => findings?.length ? h('div', { class: 'stack-sm' }, statusList(findings.map((f) => ({ ...f, status: f.status === 'error' ? 'missing' : f.status }))),
    ...findings.filter((f) => f.nodeIds?.length).slice(0, 4).map((f) => h('div', { class: 'row row-wrap small' }, h('span', { class: 'muted' }, `${f.title}:`), f.nodeIds.map((id) => button(`Show ${nameOf(id)}`, { size: 'sm', kind: 'ghost', icon: 'pointer', onClick: () => onSelectNode?.(id) }))))) : null;

  const diffView = (proposal) => {
    const c = proposal.changes;
    const rows = [
      ...c.added.map((n) => h('div', { class: 'diff-row added' }, icon('plus', 13), h('span', {}, `Add “${n.name}”`), h('span', { class: 'muted small' }, n.type))),
      ...c.removed.map((n) => h('div', { class: 'diff-row removed' }, icon('minus', 13), h('span', {}, `Remove “${n.name}”`))),
      ...c.modified.map((n) => h('div', { class: 'diff-row modified' }, icon('edit', 13), h('span', {}, `Change “${n.name}”`), h('span', { class: 'muted small' }, n.fields.slice(0, 4).join(', ')))),
      c.edgesAdded.length || c.edgesRemoved.length ? h('div', { class: 'diff-row modified' }, icon('flows', 13), h('span', {}, `${c.edgesAdded.length} connection(s) added, ${c.edgesRemoved.length} removed`)) : null,
    ];
    return h('div', { class: 'diff', 'aria-label': 'Proposed changes' }, rows.length ? rows : h('p', { class: 'muted small' }, 'No structural changes.'));
  };

  const proposalView = (result) => {
    const p = result.proposal ?? (result.definition ? { definition: result.definition, expectedRevision: result.expectedRevision, validation: result.validation, changes: { added: [], removed: [], modified: [], edgesAdded: [], edgesRemoved: [], summary: '' }, summary: 'Proposed changes' } : null);
    if (!p) return null;
    const box = h('div', { class: 'card stack-sm', style: { padding: '14px' } });
    const discard = () => fill(box, h('p', { class: 'muted small' }, 'Proposal discarded. Your draft is unchanged.'));
    fill(box,
      h('div', { class: 'row spread' }, h('strong', {}, p.validation.ok ? 'Validated draft proposal' : 'Proposal has compilation errors'), p.validation.ok ? badge('Passes validation', 'success') : badge('Does not compile', 'danger')),
      p.summary ? h('p', { class: 'small', style: { margin: 0 } }, p.summary) : null,
      diffView(p),
      p.validation.ok ? null : h('div', { class: 'stack-sm' }, p.validation.diagnostics.filter((d) => d.severity === 'error').map((d) => h('div', { class: 'diag diag-error' }, icon('alert', 14), h('span', {}, `${d.code}: ${d.message}`)))),
      h('details', {}, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Proposed definition (JSON)'), jsonPanel(p.definition)),
      h('div', { class: 'row' },
        button('Apply to draft', { kind: 'primary', icon: 'check', disabled: !p.validation.ok, onClick: async (e) => busy(e.currentTarget, async () => {
          try {
            const saved = await api.post(`/api/flows/${encodeURIComponent(flowId)}/assistant/apply`, { definition: p.definition, expectedRevision: p.expectedRevision, ...(p.summary ? { summary: p.summary } : {}) });
            onApplied(saved);
            fill(box, h('div', { class: 'callout callout-success' }, icon('checkCircle'), h('div', {}, h('strong', {}, 'Applied to the draft'), h('p', {}, 'Nothing was deployed. Undo with Ctrl+Z, or revert it from the change history below.'))));
            toast('Validated proposal saved to draft', 'success');
            void loadHistory();
          } catch (err) {
            toast(err.status === 409 ? 'The workflow changed since this proposal was made. Ask again for a fresh proposal.' : err.message, 'error');
          }
        }) }),
        button('Discard', { kind: 'ghost', onClick: discard }),
        h('span', { class: 'muted small grow', style: { textAlign: 'right' } }, 'Saving a draft never deploys it')));
    return box;
  };

  const send = async (opts) => {
    if (busyNow) return;
    const text = opts.action ? ACTIONS.find((a) => a.id === opts.action)?.label : message.trim();
    if (!text) return;
    busyNow = true;
    for (const b of panel.querySelectorAll('.copilot-actions .chip, .copilot-send .btn')) b.disabled = true;
    log.append(h('div', { class: 'msg user' }, h('span', { class: 'who' }, icon('chat', 12), 'You'), h('div', { class: 'text' }, text)));
    const pending = h('div', { class: 'msg' }, h('span', { class: 'who' }, icon('sparkles', 12), 'Copilot'), h('div', { class: 'row muted small' }, h('span', { class: 'spinner' }), 'Checking your workspace…'));
    log.append(pending);
    pending.scrollIntoView?.({ block: 'nearest' });
    try {
      await prepare?.();
      const result = await api.post(`/api/flows/${encodeURIComponent(flowId)}/assistant`, {
        ...(opts.action ? { action: opts.action } : { message: text, history }), nodeId, ...(opts.propose ? { propose: true } : {}),
      }, { timeoutMs: 150_000 });
      if (!opts.action) {
        history.push({ role: 'user', content: text }, { role: 'assistant', content: result.text ?? '' });
        message = '';
        area.value = '';
      }
      fill(pending,
        h('span', { class: 'who' }, icon('sparkles', 12), 'Copilot', h('span', { class: 'muted', style: { fontWeight: 500 } }, result.model ? ` · answered with ${result.model}` : ' · Jasmine’s own checks')),
        result.text ? h('div', { class: 'text' }, result.text) : null,
        result.note ? h('div', { class: 'small muted' }, result.note) : null,
        findingsView(result.findings),
        result.ideas?.length ? h('div', { class: 'stack-sm' }, result.ideas.map((idea) => h('a', { href: `/?describe=${encodeURIComponent(idea.description)}`, 'data-link': '', class: 'chip' }, icon('wand', 13), idea.label))) : null,
        proposalView(result));
    } catch (e) {
      fill(pending, h('span', { class: 'who' }, icon('alert', 12), 'Copilot'), h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'The copilot could not answer'), h('p', {}, e.message))));
    } finally {
      busyNow = false;
      for (const b of panel.querySelectorAll('.copilot-actions .chip, .copilot-send .btn')) b.disabled = false;
    }
  };

  const loadHistory = async () => {
    try {
      const changes = await api.get(`/api/flows/${encodeURIComponent(flowId)}/assistant/history`);
      fill(historyBox, changes.length ? changes.map((c) => h('div', { class: 'history-item' }, icon(c.kind === 'revert' ? 'undo' : 'check', 14),
        h('div', { class: 'grow' }, h('div', {}, c.summary), h('div', { class: 'muted small' }, `${timeAgo(c.appliedAt)} · revision ${c.fromRevision} → ${c.toRevision}${c.model ? ` · ${c.model}` : ''}`)),
        button('Revert', { size: 'sm', kind: 'ghost', title: 'Restore the workflow as it was before this change, if nothing changed since', onClick: async (e) => busy(e.currentTarget, async () => {
          try {
            await prepare?.();
            // The runtime refuses once the workflow changed after this change, and says why, so later edits are never undone.
            const saved = await api.post(`/api/flows/${encodeURIComponent(flowId)}/assistant/history/${encodeURIComponent(c.id)}/revert`, { expectedRevision: getRevision?.() });
            onApplied(saved);
            toast('Change reverted in the draft', 'success');
            void loadHistory();
          } catch (err) { toast(err.message, 'error'); }
        }) }))) : h('p', { class: 'muted small' }, 'Changes you apply from the copilot are listed here. Each can be reverted until the workflow changes again.'));
    } catch { fill(historyBox); }
  };

  const ask = button('Ask', { kind: 'primary', onClick: () => send({}) });
  const generate = button('Propose changes', { onClick: () => send({ propose: true }) });
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send({}); } });

  const panel = h('div', { class: 'panel-scroll copilot' },
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Grounded in this workspace: the workflow, its validation, last run, models and knowledge. Saved credentials, connection keys and project secrets are never shared with a model, and values under secret-looking names are masked. Edits are previewed and applied only when you approve them.'),
    h('div', { class: 'copilot-actions', role: 'group', 'aria-label': 'Quick questions' }, ACTIONS.map((a) => h('button', { type: 'button', class: 'chip', onClick: () => send({ action: a.id }) }, icon(a.icon, 13), a.label))),
    log,
    h('div', { class: 'stack-sm copilot-send' }, area, h('div', { class: 'row' }, ask, generate, h('span', { class: 'muted small grow', style: { textAlign: 'right' } }, 'Ctrl+Enter to ask'))),
    h('details', { onToggle: (e) => { if (e.currentTarget.open) void loadHistory(); } }, h('summary', { class: 'field-label', style: { cursor: 'pointer' } }, 'Change history'), h('div', { style: { marginTop: '8px' } }, historyBox)));
  return panel;
}
