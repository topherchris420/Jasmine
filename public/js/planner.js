import { api, catalog } from './api.js';
import { nodeIcon, statusList } from './shared.js';
import { badge, busy, button, fill, h, icon, jsonPanel, toast } from './ui.js';

/* Describe-to-build: a plain-language request becomes a proposed workflow the user reviews and approves.
   Planning never saves anything; "Create workflow" saves a draft, and nothing runs or deploys until asked. */

export const EXAMPLES = [
  'Build a chatbot that answers questions about my PDFs.',
  'Create an AI assistant that summarizes research papers.',
  'Make an API that classifies incoming customer feedback.',
  'Build an automation that summarizes new RSS articles.',
  // Names no model server, so it plans for whichever local server is connected (Ollama, LM Studio, llama.cpp…).
  'Create a private assistant using my local model.',
];

const STORE = 'jasmine.lastPlan';
const CONFIDENCE = { high: 'Clear match', medium: 'Likely match', low: 'Best guess' };

function remember(value) {
  try {
    if (value) sessionStorage.setItem(STORE, JSON.stringify(value));
    else sessionStorage.removeItem(STORE);
  } catch { /* storage is optional */ }
}
function recall() {
  try { return JSON.parse(sessionStorage.getItem(STORE) ?? 'null'); } catch { return null; }
}

/**
 * The composer plus its plan preview. `compact` drops the examples' heading for dialogs.
 * `onCreated(flow)` runs after the user approves; by default it opens the new draft in the builder.
 */
export function composer({ navigate, compact = false, restore = true, onCreated, autofocus = false, placeholder, initial } = {}) {
  const out = h('div', { class: 'stack-lg', 'aria-live': 'polite' });
  const area = h('textarea', { rows: 3, 'aria-label': 'Describe what you want to build', placeholder: placeholder ?? 'Describe what you want to build. For example: “A chatbot that answers questions about our employee handbook.”', maxlength: 2000 });
  const submit = button('Plan my workflow', { kind: 'primary', icon: 'arrowRight', onClick: () => plan() });
  const hint = h('span', { class: 'muted small grow' }, 'Review the plan before creating a draft.');
  const box = h('div', { class: 'compose-box' }, area, h('div', { class: 'compose-foot' }, hint, submit));
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void plan(); } });

  const plan = async (opts = {}) => {
    const description = (opts.description ?? area.value).trim();
    if (description.length < 8) {
      toast('Describe what you want in a sentence or two', 'error');
      area.focus();
      return;
    }
    area.value = description;
    await busy(submit, async () => {
      fill(out, h('div', { class: 'thinking card' }, h('span', { class: 'spinner' }), h('span', {}, opts.refine ? 'Asking your model to tailor the wording…' : 'Choosing steps from the catalog and checking your workspace…')));
      try {
        const result = await api.post('/api/plan', { description, ...(opts.intent ? { intent: opts.intent } : {}), ...(opts.refine ? { refine: true } : {}) }, { timeoutMs: 120_000 });
        remember({ description, plan: result });
        await show(result);
      } catch (e) {
        fill(out, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'Couldn’t plan that'), h('p', {}, e.message))));
      }
    });
  };

  const show = async (result) => {
    const cat = await catalog().catch(() => ({ byType: new Map() }));
    fill(out, planView(result, cat, {
      onIntent: (intent) => plan({ description: result.description, intent }),
      onRefine: () => plan({ description: result.description, intent: result.intent.id, refine: true }),
      onReset: () => { remember(null); fill(out); area.value = ''; area.focus(); },
      onEdit: () => { area.focus(); area.select(); box.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); },
      onCreate: async (btn, name) => {
        await busy(btn, async () => {
          try {
            const flow = await api.post('/api/flows', { name, definition: result.definition });
            remember(null);
            toast('Draft created. Nothing is deployed until you choose to.', 'success');
            if (onCreated) onCreated(flow);
            else navigate(`/flows/${encodeURIComponent(flow.id)}?from=plan`);
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      },
    }));
  };

  const examples = h('details', { class: 'compose-starters', ...(compact ? { open: true } : {}) },
    h('summary', {}, 'Try an example', icon('chevronDown', 14)),
    h('div', { class: 'compose-examples' }, EXAMPLES.map((text) => h('button', { type: 'button', class: 'compose-example', onClick: () => { area.value = text; void plan({ description: text }); } }, h('span', {}, text), icon('arrowRight', 14)))));

  const saved = restore && !initial ? recall() : null;
  if (initial) {
    area.value = initial;
    setTimeout(() => void plan({ description: initial }));
  } else if (saved?.plan) {
    area.value = saved.description ?? '';
    void show(saved.plan);
  }
  if (autofocus) setTimeout(() => area.focus());
  return h('div', { class: 'compose' }, box, examples, out);
}

function planView(plan, cat, handlers) {
  const nameInput = h('input', { class: 'plan-name', value: plan.name, 'aria-label': 'Workflow name', maxlength: 200 });
  const create = button('Create workflow', { kind: 'primary', icon: 'check', size: 'lg', onClick: (e) => handlers.onCreate(e.currentTarget, nameInput.value.trim() || plan.name) });
  const reqs = plan.readiness.requirements;
  const missing = plan.readiness.missing;
  const realModel = reqs.some((r) => r.kind === 'model' && r.status === 'ready');
  const errors = plan.validation.diagnostics.filter((d) => d.severity === 'error');

  const left = h('section', { class: 'plan-card', 'aria-label': 'Proposed workflow' },
    h('div', { class: 'plan-meta' }, h('span', { class: 'eyebrow' }, 'Proposed workflow'), badge(plan.intent.label, 'accent'), badge(CONFIDENCE[plan.intent.confidence] ?? plan.intent.confidence, plan.intent.confidence === 'low' ? 'warning' : 'neutral')),
    h('div', {}, nameInput, h('p', { class: 'lede', style: { marginTop: '4px', fontSize: '14.5px' } }, plan.summary)),
    plan.intent.signals?.length ? h('p', { class: 'small muted' }, `Understood: ${plan.intent.signals.join(' · ')}`) : null,
    h('ol', { class: 'plan-steps', 'aria-label': 'Steps' }, plan.steps.map((step, i) => {
      const spec = cat.byType.get(step.type);
      return h('li', { class: 'plan-step' },
        nodeIcon(spec ?? { category: 'app', icon: 'app' }, 34),
        h('div', {}, h('strong', {}, `${i + 1}. ${step.name}`), h('span', { class: 'muted small' }, ` · ${spec?.label ?? step.type}`),
          h('p', { class: 'what' }, step.summary), step.role && step.role !== step.summary ? h('p', { class: 'why' }, step.role) : null));
    })),
    h('div', { class: 'how-to' }, icon('info', 16), h('div', {}, h('strong', {}, `How you’ll use it · ${plan.trigger.label}`), h('div', {}, plan.trigger.howToUse))),
    plan.assumptions?.length ? h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, 'Assumptions to review'), h('ul', { class: 'small', style: { margin: 0, paddingLeft: '18px', color: 'var(--text-2)' } }, plan.assumptions.map((a) => h('li', {}, a)))) : null,
    plan.alternatives?.length ? h('div', { class: 'plan-alt' }, h('span', {}, 'Not what you meant? Try:'), plan.alternatives.map((alt) => h('button', { type: 'button', class: 'chip', onClick: () => handlers.onIntent(alt.id) }, alt.label))) : null,
    h('details', {}, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Show the workflow definition (JSON)'), h('div', { style: { marginTop: '8px' } }, jsonPanel(plan.definition, 'Definition'))));

  const right = h('section', { class: 'plan-card', 'aria-label': 'Readiness' },
    h('div', { class: 'row spread' }, h('h2', {}, 'Before you test it'),
      missing ? badge(`${missing} to set up`, 'warning') : badge('Ready to test', 'success')),
    h('p', { class: 'small muted', style: { margin: 0 } }, missing ? 'You can create the workflow now and finish these afterwards. The builder keeps this checklist.' : 'Everything the steps need is available in this workspace.'),
    reqs.length ? statusList(reqs, { compact: true }) : h('p', { class: 'muted small' }, 'This workflow needs no model, knowledge or credentials.'),
    errors.length
      ? h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Validation found issues'), h('ul', {}, errors.map((d) => h('li', {}, d.message)))))
      : h('div', { class: 'row small', style: { color: 'var(--success)' } }, icon('checkCircle', 15), 'Passes Jasmine’s workflow validation'),
    h('div', { class: 'small muted' }, plan.tailoring.note),
    realModel && !plan.tailoring.requested ? button('Tailor the wording with my model', { size: 'sm', icon: 'sparkles', onClick: () => handlers.onRefine() }) : null,
    h('div', { class: 'plan-actions' }, create, button('Edit description', { kind: 'ghost', icon: 'edit', onClick: handlers.onEdit }), button('Start over', { kind: 'ghost', onClick: handlers.onReset })),
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Creating saves a draft in this workspace. Nothing runs, deploys or becomes public until you choose to.'));

  return h('div', { class: 'plan' }, left, right);
}
