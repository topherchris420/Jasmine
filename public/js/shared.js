import { h, icon } from './ui.js';

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
