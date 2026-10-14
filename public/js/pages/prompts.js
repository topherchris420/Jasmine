import { api } from '../api.js';
import { button, confirmDialog, emptyState, field, fill, h, input, modal, page, select, table, textarea, timeAgo, toast } from '../ui.js';

const ROLES = ['system', 'user', 'assistant'];

export async function render(container) {
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const list = await api.get('/api/prompts');
    fill(body, table([
      { label: 'Prompt', render: (p) => h('div', {}, h('div', { class: 'cell-title' }, p.name), p.description ? h('div', { class: 'cell-sub' }, p.description) : null) },
      { label: 'Messages', render: (p) => h('span', { class: 'muted' }, p.messages.map((m) => m.role).join(' → ')) },
      { label: 'Preview', render: (p) => h('span', { class: 'muted small truncate', style: { display: 'block', maxWidth: '360px' } }, p.messages[0]?.content ?? '') },
      { label: 'Updated', render: (p) => h('span', { class: 'muted nowrap' }, timeAgo(p.updatedAt)) },
      { label: '', class: 'num', render: (p) => button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete prompt', onClick: async () => {
        if (!await confirmDialog(`Delete the prompt "${p.name}"? Flows that already inserted it keep their copy.`, { danger: true, confirmLabel: 'Delete' })) return;
        await api.del(`/api/prompts/${p.id}`);
        void draw();
      } }) },
    ], list, {
      onRowClick: (p) => edit(p, draw),
      empty: emptyState('prompts', 'No prompts yet', 'Save system prompts and few-shot examples once, then insert them into any AI node from its prompt editor.', button('New prompt', { kind: 'primary', icon: 'plus', onClick: () => edit(null, draw) })),
    }));
  };
  container.append(page('Prompts', 'A shared library of prompt templates. Use {{triggerNode_1.output.field}} or {{nodeId.output.field}} references just as in node prompts.',
    [button('New prompt', { kind: 'primary', icon: 'plus', onClick: () => edit(null, draw) })], body));
  await draw();
}

function edit(prompt, done) {
  const v = { name: prompt?.name ?? '', description: prompt?.description ?? '', messages: structuredClone(prompt?.messages ?? [{ role: 'system', content: '' }, { role: 'user', content: '{{triggerNode_1.output.chatMessage}}' }]) };
  const list = h('div', { class: 'stack-sm' });
  const drawMessages = () => fill(list, v.messages.map((m, i) => h('div', { class: 'message-row' },
    select(ROLES, m.role, (x) => (v.messages[i].role = x)),
    textarea(m.content, (x) => (v.messages[i].content = x), { rows: m.role === 'system' ? 5 : 3, placeholder: m.role === 'system' ? 'You are a helpful assistant that…' : 'Message' }),
    button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove message', disabled: v.messages.length === 1, onClick: () => { v.messages.splice(i, 1); drawMessages(); } }))),
  h('div', {}, button('Add message', { icon: 'plus', size: 'sm', onClick: () => { v.messages.push({ role: v.messages.at(-1)?.role === 'user' ? 'assistant' : 'user', content: '' }); drawMessages(); } })));
  drawMessages();
  modal({
    title: prompt ? `Edit ${prompt.name}` : 'New prompt', wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'grid grid-2' }, field('Name', input(v.name, (x) => (v.name = x), { placeholder: 'Support agent persona' })), field('Description', input(v.description, (x) => (v.description = x)))),
      h('div', { class: 'field-label' }, 'Messages'), list),
    actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Save prompt', kind: 'primary', icon: 'check', onClick: async (close) => {
      try {
        const payload = { name: v.name, description: v.description, messages: v.messages };
        if (prompt) await api.put(`/api/prompts/${prompt.id}`, payload);
        else await api.post('/api/prompts', payload);
        close();
        toast('Prompt saved', 'success');
        done();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }],
  });
}
