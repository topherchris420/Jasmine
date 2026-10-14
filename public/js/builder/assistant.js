import { api } from '../api.js';
import { button, field, h, jsonPanel, textarea, toast } from '../ui.js';

export function assistantPanel({ flowId, nodeId, prepare, onApplied }) {
  const history = [],
    chat = h('div', { class: 'stack-sm' }),
    proposal = h('div', { class: 'stack-sm' });
  let message = '',
    busy = false;
  const send = async (propose) => {
    if (busy || !message.trim()) return;
    busy = true;
    ask.disabled = true;
    generate.disabled = true;
    try {
      await prepare?.();
      const text = message;
      chat.append(h('div', { class: 'card' }, h('strong', {}, 'You'), h('p', {}, text)));
      const result = await api.post(`/api/flows/${encodeURIComponent(flowId)}/assistant`, {
        message: text,
        nodeId,
        history,
        propose,
      });
      history.push({ role: 'user', content: text }, { role: 'assistant', content: result.text });
      chat.append(
        h(
          'div',
          { class: 'card' },
          h('strong', {}, 'Jasmine'),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, result.text),
        ),
      );
      if (propose) {
        proposal.replaceChildren(
          h('strong', {}, result.validation.ok ? 'Validated draft proposal' : 'Proposal has compilation errors'),
          jsonPanel(result.definition),
          ...result.validation.diagnostics.map((d) => h('p', { class: 'small' }, `${d.code}: ${d.message}`)),
          button('Apply to draft', {
            kind: 'primary',
            disabled: !result.validation.ok,
            onClick: async () => {
              try {
                const saved = await api.post(`/api/flows/${encodeURIComponent(flowId)}/assistant/apply`, {
                  definition: result.definition,
                  expectedRevision: result.expectedRevision,
                });
                onApplied(saved);
                toast('Validated proposal saved to draft', 'success');
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          }),
        );
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy = false;
      ask.disabled = false;
      generate.disabled = false;
    }
  };
  const ask = button('Ask', { kind: 'primary', onClick: () => send(false) }),
    generate = button('Propose changes', { onClick: () => send(true) });
  return h(
    'div',
    { class: 'panel-scroll stack' },
    h('h2', {}, nodeId ? `Ask about ${nodeId}` : 'Flow assistant'),
    h(
      'p',
      { class: 'muted small' },
      'Uses your local model and current flow context. Generated edits must compile and be reviewed before applying. Applying saves a draft.',
    ),
    chat,
    field(
      'Message',
      textarea('', (v) => (message = v), {
        rows: 5,
        placeholder: 'Explain this flow, fix an error, or propose a change. Use @nodeId to focus on a node.',
      }),
    ),
    h('div', { class: 'row' }, ask, generate),
    proposal,
  );
}
