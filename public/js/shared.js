import { button, h, icon } from './ui.js';

export const CATEGORY = {
  trigger: { label: 'Triggers', color: 'var(--c-trigger)' },
  ai: { label: 'AI', color: 'var(--c-ai)' },
  rag: { label: 'RAG & Memory', color: 'var(--c-rag)' },
  data: { label: 'Data', color: 'var(--c-data)' },
  logic: { label: 'Logic', color: 'var(--c-logic)' },
  app: { label: 'Apps', color: 'var(--c-app)' },
  response: { label: 'Responses', color: 'var(--c-response)' },
};

export const TRIGGER_LABEL = {
  graphqlNode: 'API', webhookTriggerNode: 'Webhook', chatTriggerNode: 'Chat widget', searchTriggerNode: 'Search widget', askTriggerNode: 'Ask widget',
  cronNode: 'Schedule', localFolderNode: 'Local folder', sourceTriggerNode: 'Scheduled source', mailhookNode: 'Inbound email',
};
export const TRIGGER_ICON = { graphqlNode: 'api', webhookTriggerNode: 'webhook', chatTriggerNode: 'chat', searchTriggerNode: 'search', askTriggerNode: 'ask', cronNode: 'clock', localFolderNode: 'folder', sourceTriggerNode: 'database', mailhookNode: 'mail' };

export function nodeIcon(spec, size = 30) {
  const color = CATEGORY[spec?.category]?.color ?? 'var(--text-3)';
  return h('span', { class: 'node-icon', style: { background: color, width: `${size}px`, height: `${size}px` } }, icon(spec?.icon ?? 'app', Math.round(size * 0.53)));
}

export function triggerChip(type) {
  if (!type) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'row', style: { gap: '6px' } }, icon(TRIGGER_ICON[type] ?? 'api', 14), TRIGGER_LABEL[type] ?? type);
}

/** Origin the API is served from (for code snippets). */
export const origin = () => location.origin;

/* ---------- lifecycle, readiness and explanations ---------- */

const LIFECYCLE_TEXT = { draft: 'Draft', validated: 'Validated', deployed: 'Deployed', failed: 'Failed', disabled: 'Disabled' };

/** Draft · Validated · Deployed · Failed · Disabled, with the reason as a tooltip and accessible description. */
export function lifecycleBadge(summary) {
  const lc = summary?.lifecycle ?? { state: summary?.deployedVersion ? 'deployed' : 'draft', label: summary?.deployedVersion ? 'Deployed' : 'Draft', detail: '' };
  const pending = lc.state === 'deployed' && summary?.draftChanged;
  return h('span', { class: ['lc', `lc-${lc.state}`, pending ? 'pending' : ''], title: lc.detail || undefined, 'aria-label': `${lc.label ?? LIFECYCLE_TEXT[lc.state]}${lc.detail ? `: ${lc.detail}` : ''}` }, lc.label ?? LIFECYCLE_TEXT[lc.state], pending ? ' · changes' : '');
}

const REQ_ICON = { missing: 'alert', warning: 'alert', ready: 'check', info: 'info', fail: 'xCircle', pass: 'check', warn: 'alert', skip: 'minus', error: 'xCircle' };
const REQ_LABEL = { missing: 'Needs action', warning: 'Check', ready: 'Ready', info: 'Note', fail: 'Failed', pass: 'Passed', warn: 'Warning', skip: 'Not checked', error: 'Error' };

/** Status list used for requirements, diagnoses and copilot findings. Actions are in-app links. */
export function statusList(items, { compact = false, onAction } = {}) {
  return h('ul', { class: ['req-list', compact ? 'compact' : ''] }, items.map((item) => {
    const status = item.status ?? 'info';
    return h('li', { class: ['req-item', status] },
      h('span', { class: 'req-icon', title: REQ_LABEL[status] }, icon(REQ_ICON[status] ?? 'info', 14), h('span', { class: 'sr-only' }, REQ_LABEL[status] ?? status)),
      h('div', { class: 'grow' }, h('strong', {}, item.title ?? item.label), item.detail ? h('p', {}, item.detail) : null,
        item.steps?.length ? h('ol', {}, item.steps.map((step) => h('li', {}, step))) : null),
      item.action ? h('a', { href: item.action.href, 'data-link': '', class: 'btn btn-sm btn-secondary', onClick: () => onAction?.(item) }, item.action.label) : h('span'));
  }));
}

/** A failure explained: what failed, the likely cause, how to recover, and the original error kept visible. */
export function explanationCard(explanation, { onShowNode } = {}) {
  if (!explanation) return null;
  return h('div', { class: 'explain', role: 'alert' },
    h('h3', {}, icon('alert', 16), explanation.title),
    h('div', { class: 'small' }, h('strong', {}, explanation.component), ' · ', explanation.cause),
    explanation.steps?.length ? h('div', {}, h('div', { class: 'field-label' }, 'How to fix it'), h('ol', {}, explanation.steps.map((s) => h('li', {}, s)))) : null,
    h('div', { class: 'row row-wrap' },
      ...(explanation.actions ?? []).map((a) => h('a', { href: a.href, 'data-link': '', class: 'btn btn-sm btn-secondary' }, a.label)),
      onShowNode ? button('Show the step', { size: 'sm', kind: 'ghost', icon: 'pointer', onClick: onShowNode }) : null),
    h('div', { class: 'raw' }, `${explanation.code}: ${explanation.message}`));
}
