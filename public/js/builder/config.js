import { api } from '../api.js';
import { explanationCard, nodeIcon } from '../shared.js';
import { append, badge, button, clear, copyButton, field, fill, h, icon, input, jsonPanel, select, tabs, textarea, toggle } from '../ui.js';
import { branchOptions, isBranching, isTrigger, nodeName, typeOf, upstream } from './graph.js';

/* ---------- shared lookups (cached per builder session) ---------- */

export function createLookups() {
  const cache = new Map();
  const once = (key, load) => {
    if (!cache.has(key)) cache.set(key, load().catch((e) => {
      cache.delete(key);
      throw e;
    }));
    return cache.get(key);
  };
  return {
    models: () => once('models', () => api.get('/api/models')),
    collections: () => once('collections', () => api.get('/api/collections')),
    integrations: () => once('integrations', () => api.get('/api/integrations')),
    flows: () => once('flows', () => api.get('/api/flows')),
    prompts: () => once('prompts', () => api.get('/api/prompts')),
    invalidate: (key) => cache.delete(key),
  };
}

/* ---------- reference picker ---------- */

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !e.target.closest('.ref-menu, .ref-btn')) closeMenu();
});

function outputPaths(node, catalog) {
  const spec = catalog.byType.get(typeOf(node));
  const v = node.data.values ?? {};
  const paths = new Set();
  const expand = (p) => {
    if (p === '<field>' || p === '<name>' || p === '<argument>') {
      let keys = [];
      try {
        const schema = typeof v.advance_schema === 'string' && v.advance_schema.trim() ? JSON.parse(v.advance_schema) : v.advance_schema;
        if (schema && typeof schema === 'object') keys = Object.keys(schema.properties ?? schema);
      } catch { /* ignore */ }
      try {
        const out = typeof v.schema === 'string' ? JSON.parse(v.schema) : v.schema;
        if (out?.properties) keys.push(...Object.keys(out.properties));
      } catch { /* ignore */ }
      try {
        const mapping = typeof v.mapping === 'string' ? JSON.parse(v.mapping) : v.mapping;
        if (mapping && typeof mapping === 'object') keys.push(...Object.keys(mapping));
      } catch { /* ignore */ }
      if (Array.isArray(v.agents)) for (const a of v.agents) {
        try {
          const s = typeof a.schema === 'string' ? JSON.parse(a.schema) : a.schema;
          keys.push(...Object.keys(s?.properties ?? s ?? {}));
        } catch { /* ignore */ }
      }
      for (const k of keys) paths.add(k);
      return;
    }
    paths.add(p);
  };
  for (const o of spec?.outputs ?? []) expand(o.path);
  return [...paths];
}

export function refMenu(anchor, target, ctx) {
  closeMenu();
  const nodes = upstream(ctx.def, ctx.node.id);
  const menu = h('div', { class: 'ref-menu', role: 'menu' });
  if (!nodes.length) menu.append(h('div', { class: 'muted small', style: { padding: '8px' } }, 'Connect this node below another node to reference its output.'));
  for (const n of nodes) {
    menu.append(h('div', { class: 'ref-group' }, `${nodeName(n, ctx.catalog)} · ${n.id}`));
    const refs = [`${n.id}.output`, ...outputPaths(n, ctx.catalog).map((p) => `${n.id}.output.${p}`)];
    for (const ref of refs) menu.append(h('button', { type: 'button', class: 'ref-item', role: 'menuitem', onClick: () => {
      insertAtCursor(target, `{{${ref}}}`);
      closeMenu();
    } }, `{{${ref}}}`));
  }
  menu.append(h('div', { class: 'ref-group' }, 'Project'), h('button', { type: 'button', class: 'ref-item', onClick: () => { insertAtCursor(target, '{{secrets.project.NAME}}'); closeMenu(); } }, '{{secrets.project.NAME}}'), h('button', { type: 'button', class: 'ref-item', onClick: () => { insertAtCursor(target, '{{env.NAME}}'); closeMenu(); } }, '{{env.NAME}}'));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - 330)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - 340, innerWidth - 350))}px`;
  openMenu = menu;
}

function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

function withRef(control, ctx) {
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon ref-btn', title: 'Insert a reference to an upstream output', 'aria-label': 'Insert reference', onClick: (e) => refMenu(e.currentTarget, control, ctx) }, icon('json', 14));
  return h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '4px' } }, h('div', { class: 'grow' }, control), btn);
}

/* ---------- value editors ---------- */

const isTemplateOnly = (s) => /^\s*\{\{[^{}]+\}\}\s*$/.test(s);

function jsonEditor(value, set, opts = {}) {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
  const area = textarea(text, (v) => {
    set(opts.object && v.trim() && !isTemplateOnly(v) ? safeParse(v) ?? v : v);
    check(v);
  }, { mono: true, rows: opts.rows ?? 6, placeholder: opts.placeholder });
  const check = (v) => {
    let ok = true;
    if (v.trim() && !isTemplateOnly(v)) {
      try {
        JSON.parse(v.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""').replace(/\{\{[^{}]+\}\}/g, '0'));
      } catch {
        ok = false;
      }
    }
    area.classList.toggle('invalid', !ok);
    area.title = ok ? '' : 'Not valid JSON';
  };
  check(text);
  return area;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function listEditor(items, renderItem, onAdd, addLabel) {
  return h('div', { class: 'list-editor' }, items.map((item, i) => renderItem(item, i)), button(addLabel, { icon: 'plus', size: 'sm', onClick: onAdd }));
}

const ROLE_OPTIONS = [{ value: 'system', label: 'System' }, { value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }];

function promptsEditor(value, set, ctx, rerender) {
  const prompts = Array.isArray(value) ? value : [];
  const update = () => set([...prompts]);
  return h('div', { class: 'stack-sm' },
    listEditor(prompts, (p, i) => h('div', { class: 'list-item' },
      h('div', { class: 'list-item-head' },
        select(ROLE_OPTIONS, p.role ?? 'user', (role) => { prompts[i] = { ...p, role }; update(); }, { style: 'width:130px' }),
        h('span', { class: 'grow' }),
        button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remove message', onClick: () => { prompts.splice(i, 1); update(); rerender(); } })),
      withRef(textarea(p.content ?? '', (content) => { prompts[i] = { ...prompts[i], content }; update(); }, { rows: p.role === 'system' ? 4 : 3, placeholder: p.role === 'system' ? 'Instructions for the model' : 'Message; insert {{refs}} with the button' }), ctx)),
    () => { prompts.push({ id: crypto.randomUUID(), role: 'user', content: '' }); update(); rerender(); }, 'Add message'),
    ctx.lookups ? button('Insert from prompt library', { icon: 'prompts', size: 'sm', kind: 'ghost', onClick: async () => {
      const library = await ctx.lookups.prompts();
      if (!library.length) return ctx.toast('The prompt library is empty; add prompts under Prompts.');
      const pick = h('div', { class: 'stack-sm' }, library.map((p) => button(p.name, { onClick: () => {
        prompts.push(...p.messages.map((m) => ({ id: crypto.randomUUID(), ...m })));
        update();
        rerender();
        pick.closest('dialog')?.close();
      } })));
      ctx.modal({ title: 'Prompt library', body: pick });
    } }) : null);
}

const OPERATORS = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'not contains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty', 'ilike', 'in', 'matches'];

function conditionsEditor(value, set, ctx, rerender) {
  const entries = Array.isArray(value) ? value.map((c) => ({ ...c })) : [];
  const update = () => set(entries.map((c) => ({ ...c })));
  const parsed = (c) => {
    const raw = typeof c.condition === 'string' ? safeParse(c.condition) : c.condition;
    return raw && typeof raw === 'object' ? raw : {};
  };
  const isElse = (c) => !parsed(c).operands?.length;
  const write = (i, group) => {
    entries[i].condition = JSON.stringify(group);
    update();
  };
  return listEditor(entries, (c, i) => {
    const group = parsed(c);
    const operands = Array.isArray(group.operands) ? group.operands : [];
    const elseBranch = isElse(c) && i === entries.length - 1;
    return h('div', { class: 'list-item' },
      h('div', { class: 'list-item-head' },
        input(c.label ?? '', (label) => { entries[i].label = label; update(); }, { placeholder: 'Branch label', style: 'flex:1' }),
        elseBranch ? badge('Else', 'neutral') : select([{ value: 'and', label: 'All match' }, { value: 'or', label: 'Any matches' }], /^or$/i.test(group.operator ?? '') ? 'or' : 'and', (op) => write(i, { ...group, operator: op })),
        entries.length > 1 ? button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remove branch', onClick: () => { entries.splice(i, 1); update(); rerender(); } }) : null),
      elseBranch ? h('div', { class: 'muted small' }, 'Runs when no other branch matches.') : h('div', { class: 'stack-sm' },
        operands.map((o, j) => h('div', { class: 'row', style: { gap: '4px' } },
          withRef(input(String(o.name ?? ''), (name) => { operands[j] = { ...operands[j], name }; write(i, { ...group, operands }); }, { placeholder: '{{node.output.value}}' }), ctx),
          select(OPERATORS, o.operator ?? '==', (operator) => { operands[j] = { ...operands[j], operator }; write(i, { ...group, operands }); }, { style: 'width:110px' }),
          ['isEmpty', 'isNotEmpty'].includes(o.operator) ? null : input(String(o.value ?? ''), (v) => { operands[j] = { ...operands[j], value: v }; write(i, { ...group, operands }); }, { placeholder: 'value', style: 'width:110px' }),
          button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove rule', onClick: () => { operands.splice(j, 1); write(i, { ...group, operands }); rerender(); } }))),
        button('Add rule', { icon: 'plus', size: 'sm', kind: 'ghost', onClick: () => { operands.push({ name: '', operator: '==', value: '' }); write(i, { operator: group.operator ?? 'and', ...group, operands }); rerender(); } })));
  }, () => {
    const at = entries.length && isElse(entries.at(-1)) ? entries.length - 1 : entries.length;
    entries.splice(at, 0, { label: `Condition ${at + 1}`, value: `${ctx.node.id}-c${Date.now().toString(36)}`, condition: JSON.stringify({ operator: 'and', operands: [{ name: '', operator: '==', value: '' }] }) });
    update();
    rerender();
  }, 'Add branch');
}

function simpleListEditor(value, set, rerender, fields, make, addLabel) {
  const items = Array.isArray(value) ? value.map((x) => ({ ...x })) : [];
  const update = () => set(items.map((x) => ({ ...x })));
  return listEditor(items, (item, i) => h('div', { class: 'list-item' },
    h('div', { class: 'list-item-head' }, h('strong', { class: 'grow small' }, item[fields[0].key] || `Item ${i + 1}`), button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remove', onClick: () => { items.splice(i, 1); update(); rerender(); } })),
    fields.map((f) => field(f.label, f.type === 'json'
      ? jsonEditor(item[f.key] ?? '', (v) => { items[i][f.key] = v; update(); }, { rows: 3 })
      : f.type === 'area' ? textarea(item[f.key] ?? '', (v) => { items[i][f.key] = v; if (f.sync) items[i][f.sync] = f.syncFn(v); update(); }, { rows: 2 })
        : input(item[f.key] ?? '', (v) => { items[i][f.key] = v; if (f.sync) items[i][f.sync] = f.syncFn(v); update(); }, { placeholder: f.placeholder ?? '' })))),
  () => { items.push(make(items.length)); update(); rerender(); }, addLabel);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'option';

function stringList(value, set) {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? (safeParse(value) ?? value.split(',')) : [];
  return textarea((Array.isArray(list) ? list : []).join('\n'), (v) => set(v.split('\n').map((x) => x.trim()).filter(Boolean)), { rows: 3, placeholder: 'One per line' });
}

function mappingEditor(value, set, ctx, rerender) {
  const obj = (typeof value === 'string' ? safeParse(value) : value) ?? {};
  const rows = Object.entries(obj).map(([name, spec]) => ({ name, type: spec?.type ?? 'string', value: spec?.value ?? '' }));
  const write = () => set(JSON.stringify(Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.name, { type: r.type, value: r.value }])), null, 2));
  return listEditor(rows, (r, i) => h('div', { class: 'row', style: { gap: '4px' } },
    input(r.name, (v) => { rows[i].name = v; write(); }, { placeholder: 'name', style: 'width:110px' }),
    select(['string', 'number', 'boolean', 'object', 'array'], r.type, (v) => { rows[i].type = v; write(); }, { style: 'width:95px' }),
    withRef(input(typeof r.value === 'string' ? r.value : JSON.stringify(r.value), (v) => { rows[i].value = v; write(); }, { placeholder: 'value or {{ref}}' }), ctx),
    button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove', onClick: () => { rows.splice(i, 1); write(); rerender(); } })),
  () => { rows.push({ name: `var${rows.length + 1}`, type: 'string', value: '' }); write(); rerender(); }, 'Add variable');
}

const TOOL_TYPES = [
  { value: 'vectorSearch', label: 'Search a knowledge base' }, { value: 'flow', label: 'Run another flow' },
  { value: 'http', label: 'Call an HTTP API' }, { value: 'code', label: 'Run JavaScript' }, { value: 'mcp', label: 'MCP server tools' },
];

function toolsEditor(value, set, ctx, rerender) {
  const tools = (Array.isArray(value) ? value : []).filter((t) => t && typeof t === 'object').map((t) => ({ ...t }));
  const imported = (Array.isArray(value) ? value : []).filter((t) => typeof t === 'string');
  const update = () => set([...tools, ...imported]);
  return h('div', { class: 'stack-sm' },
    imported.length ? h('div', { class: 'callout callout-warning small' }, icon('alert'), `${imported.length} imported tool reference(s) have no local definition and are ignored.`) : null,
    listEditor(tools, (t, i) => {
      const set1 = (k, v) => { tools[i] = { ...tools[i], [k]: v }; update(); };
      const typeFields = {
        vectorSearch: [field('Vector database', asyncSelect(ctx.lookups.collections().then((cs) => cs.filter((c) => c.kind === 'knowledge').map((c) => ({ value: c.name, label: c.name }))), t.vectorDB, (v) => set1('vectorDB', v))), field('Results', input(t.limit ?? 4, (v) => set1('limit', Number(v) || 4), { type: 'number' }))],
        flow: [field('Flow', asyncSelect(ctx.lookups.flows().then((fs) => fs.filter((f) => f.id !== ctx.flowId).map((f) => ({ value: f.id, label: `${f.name}${f.deployedVersion ? '' : ' (not deployed)'}` }))), t.flowId, (v) => set1('flowId', v))), field('Arguments schema', jsonEditor(t.parameters ? JSON.stringify(t.parameters, null, 2) : '', (v) => set1('parameters', safeParse(v)), { rows: 3, placeholder: '{"type":"object","properties":{"question":{"type":"string"}}}' }))],
        http: [field('Method', select(['GET', 'POST'], t.method ?? 'GET', (v) => set1('method', v))), field('URL', input(t.url ?? '', (v) => set1('url', v))), field('Arguments schema', jsonEditor(t.parameters ? JSON.stringify(t.parameters, null, 2) : '', (v) => set1('parameters', safeParse(v)), { rows: 3 }))],
        code: [field('Arguments schema', jsonEditor(t.parameters ? JSON.stringify(t.parameters, null, 2) : '', (v) => set1('parameters', safeParse(v)), { rows: 3 })), field('JavaScript (args holds the arguments; return the result)', textarea(t.code ?? '', (v) => set1('code', v), { mono: true, rows: 5 }))],
        mcp: [field('MCP server', asyncSelect(ctx.lookups.integrations().then((d) => d.credentials.filter((c) => c.integration === 'mcp').map((c) => ({ value: c.name, label: c.name }))), t.credential, (v) => set1('credential', v))), field('Only these tools (one per line, empty = all)', stringList(t.tools ?? [], (v) => set1('tools', v)))],
      }[t.type] ?? [];
      return h('div', { class: 'list-item' },
        h('div', { class: 'list-item-head' }, select(TOOL_TYPES, t.type, (v) => { tools[i] = { type: v, name: tools[i].name }; update(); rerender(); }), h('span', { class: 'grow' }), button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remove tool', onClick: () => { tools.splice(i, 1); update(); rerender(); } })),
        field('Name', input(t.name ?? '', (v) => set1('name', v.replace(/[^A-Za-z0-9_-]/g, '_')), { placeholder: 'search_docs' })),
        field('Description for the model', input(t.description ?? '', (v) => set1('description', v), { placeholder: 'When to use this tool' })),
        ...typeFields);
    }, () => { tools.push({ type: 'vectorSearch', name: `tool_${tools.length + 1}`, limit: 4 }); update(); rerender(); }, 'Add tool'));
}

function asyncSelect(optionsPromise, value, onChange, { allowCustom = true, placeholder = 'Choose…' } = {}) {
  const el = h('select', { class: 'input', onChange: (e) => onChange(e.target.value) }, h('option', { value: value ?? '' }, value || placeholder));
  optionsPromise.then((options) => {
    fill(el, h('option', { value: '' }, placeholder));
    const seen = new Set();
    for (const o of options) {
      seen.add(o.value);
      el.append(h('option', { value: o.value, selected: o.value === value }, o.label));
    }
    if (allowCustom && value && !seen.has(value)) el.append(h('option', { value, selected: true }, `${value} (not found)`));
  }).catch(() => {});
  return el;
}

/** Model picker: a connection/model pair stored as Studio config objects; an optional second config is the fallback. */
function modelEditor(value, set, ctx, purpose) {
  const configs = (Array.isArray(value) ? value : value ? [value] : []).filter((c) => c && typeof c === 'object');
  const encode = (c) => (c?.connection || c?.model_name ? `${c.connection ?? ''}::${c.model_name ?? ''}` : '');
  const decode = (v) => {
    if (!v) return null;
    const [connection, model] = v.split('::');
    return { connection, model_name: model, provider_name: connection, type: purpose === 'embedding' ? 'embedder/text' : 'generator/text' };
  };
  const options = ctx.lookups.models().then((list) => list.flatMap((c) => {
    const models = c.models.filter((m) => (purpose === 'embedding' ? m.kind === 'embedding' : m.kind === 'chat'));
    return [
      { value: `${c.connection}::`, label: `${c.name}: default ${purpose} model${c.ok ? '' : ' (offline)'}` },
      ...models.map((m) => ({ value: `${c.connection}::${m.id}`, label: `${c.name}: ${m.id}` })),
    ];
  }));
  const write = (i, v) => {
    const next = [...configs];
    const decoded = decode(v);
    if (decoded) next[i] = decoded;
    else next.splice(i, 1);
    set(purpose === 'embedding' ? next[0] ?? '' : next);
  };
  const imported = configs[0] && !configs[0].connection && configs[0].model_name;
  return h('div', { class: 'stack-sm' },
    asyncSelect(options, encode(configs[0]), (v) => write(0, v), { placeholder: `Project default ${purpose} model` }),
    imported ? h('div', { class: 'field-help' }, `Imported model “${configs[0].model_name}” (${configs[0].provider_name ?? 'cloud'}) runs on your default local model unless you pick one.`) : null,
    purpose === 'chat' && configs[0] ? h('label', { class: 'field' }, h('span', { class: 'field-help' }, 'Fallback model (used if the first one fails)'), asyncSelect(options, encode(configs[1]), (v) => write(1, v), { placeholder: 'No fallback' })) : null);
}

function chatConfigEditor(value, set) {
  const c = { ...(value && typeof value === 'object' ? value : {}) };
  const update = () => set({ ...c });
  return h('div', { class: 'stack-sm' },
    field('Bot name', input(c.botName ?? '', (v) => { c.botName = v; update(); })),
    field('Greeting', input(c.greetingMessage ?? '', (v) => { c.greetingMessage = v; update(); })),
    field('Suggested questions', stringList(c.suggestions ?? [], (v) => { c.suggestions = v; update(); })),
    field('Accent colour', h('input', { type: 'color', class: 'input', style: 'height:34px;padding:2px', value: c.colors?.primary ?? '#5b5bd6', onInput: (e) => { c.colors = { ...(c.colors ?? {}), primary: e.target.value }; update(); } })));
}

const CRON_PRESETS = [['*/15 * * * *', 'Every 15 min'], ['0 * * * *', 'Hourly'], ['0 9 * * *', 'Daily 9:00'], ['0 9 * * 1-5', 'Weekdays 9:00'], ['0 8 * * 1', 'Mondays 8:00']];

function editorFor(f, node, ctx, rerender) {
  const values = node.data.values;
  const value = values[f.key];
  const set = (v) => {
    if (v === undefined || v === '') delete values[f.key];
    else values[f.key] = v;
    ctx.onChange();
  };
  switch (f.type) {
    case 'text': return withRef(input(typeof value === 'string' || typeof value === 'number' ? value : value === undefined ? '' : JSON.stringify(value), set, { placeholder: f.placeholder ?? '' }), ctx);
    case 'textarea': return withRef(textarea(value ?? '', set, { rows: 4, placeholder: f.placeholder ?? '' }), ctx);
    case 'messages': return withRef(input(typeof value === 'string' ? value : JSON.stringify(value ?? ''), set, { placeholder: '{{triggerNode_1.output.chatHistory}}' }), ctx);
    case 'code': return withRef(textarea(value ?? '', set, { mono: true, rows: 12 }), ctx);
    case 'json': case 'schema': return withRef(jsonEditor(value, set, { rows: f.type === 'schema' ? 10 : 6, placeholder: f.placeholder }), ctx);
    case 'number': return input(value ?? '', (v) => set(v === '' ? undefined : Number(v)), { type: 'number' });
    case 'boolean': return toggle(value === true || value === 'true', (v) => set(v));
    case 'select': return select(f.options ?? [], value ?? f.options?.[0]?.value, set);
    case 'model': return modelEditor(value, set, ctx, 'chat');
    case 'embeddingModel': return modelEditor(value, set, ctx, 'embedding');
    case 'prompts': return promptsEditor(value, set, ctx, rerender);
    case 'conditions': return conditionsEditor(value, set, ctx, rerender);
    case 'classifier': return simpleListEditor(value, set, rerender, [{ key: 'label', label: 'Category', sync: 'value', syncFn: slug }, { key: 'description', label: 'Description (helps the model)' }], (n) => ({ label: `Category ${n + 1}`, value: `category-${n + 1}` }), 'Add category');
    case 'agents': return simpleListEditor(value, set, rerender, [{ key: 'name', label: 'Name' }, { key: 'description', label: 'What it does', type: 'area' }, { key: 'schema', label: 'Arguments ({"field": "string"})', type: 'json' }], (n) => ({ name: `Agent${n + 1}`, description: '', schema: '{"task": "string"}' }), 'Add sub-agent');
    case 'branches': return simpleListEditor(value, set, rerender, [{ key: 'label', label: 'Label', sync: 'value', syncFn: slug }], (n) => ({ label: `Branch ${n + 1}`, value: `branch-${n + 1}` }), 'Add branch');
    case 'tools': return toolsEditor(value, set, ctx, rerender);
    case 'mapping': return mappingEditor(value, set, ctx, rerender);
    case 'stringList': return stringList(value, set);
    case 'chatConfig': return chatConfigEditor(value, set);
    case 'cron': return h('div', { class: 'stack-sm' }, input(value ?? '', set, { placeholder: '0 9 * * 1-5', class: 'input mono' }), h('div', { class: 'row row-wrap', style: { gap: '4px' } }, CRON_PRESETS.map(([expr, label]) => button(label, { size: 'sm', kind: value === expr ? 'primary' : 'secondary', onClick: () => { set(expr); rerender(); } }))));
    case 'vectorDB': case 'memoryCollection': {
      const current = Array.isArray(value) ? value[0] : value;
      const kind = f.type === 'vectorDB' ? 'knowledge' : 'memory';
      return h('div', { class: 'stack-sm' },
        asyncSelect(ctx.lookups.collections().then((cs) => cs.filter((c) => c.kind === kind).map((c) => ({ value: c.name, label: `${c.name} (${c.records} records)` }))), current, set, { placeholder: kind === 'knowledge' ? 'Choose a vector database' : 'Choose a memory store' }),
        h('div', { class: 'row' }, input('', () => {}, { placeholder: 'or type a new name', onChange: (e) => { if (e.target.value.trim()) { set(e.target.value.trim()); rerender(); } } })));
    }
    case 'credential': {
      const current = typeof value === 'string' ? value : value?.name ?? value?.credential_name ?? '';
      return h('div', { class: 'stack-sm' },
        asyncSelect(ctx.lookups.integrations().then((d) => d.credentials.filter((c) => c.integration === f.integration).map((c) => ({ value: c.name, label: c.name }))), current, set, { placeholder: 'Use the only configured credential' }),
        h('a', { href: '/integrations', 'data-link': '', class: 'small' }, 'Manage credentials →'));
    }
    case 'flow': return asyncSelect(ctx.lookups.flows().then((fs) => fs.filter((x) => x.id !== ctx.flowId).map((x) => ({ value: x.id, label: `${x.name}${x.deployedVersion ? '' : ' (not deployed)'}` }))), value, set);
    case 'keyValue': return jsonEditor(value, set, { object: true, rows: 4 });
    default: return input(typeof value === 'string' ? value : JSON.stringify(value ?? ''), set);
  }
}

/* ---------- panel ---------- */

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
const REF = /\{\{\s*([A-Za-z_$][\w$-]*)((?:\.[^{}\s]+)?)\s*\}\}/g;

/** References a step reads, grouped by the step they come from. */
function readsOf(node, def) {
  const seen = new Map();
  for (const m of JSON.stringify(node.data.values ?? {}).matchAll(REF)) {
    const [, id, path] = m;
    if (['secrets', 'env', 'meta'].includes(id)) continue;
    const key = `${id}${path}`;
    if (!seen.has(key)) seen.set(key, { id, ref: `{{${key}}}`, exists: def.nodes.some((n) => n.id === id) });
  }
  return [...seen.values()];
}

function connectionsView(ctx) {
  const { node, def, catalog } = ctx;
  const nameById = (id) => { const n = def.nodes.find((x) => x.id === id); return n ? nodeName(n, catalog) : id; };
  const EXEC = ['defaultEdge', 'conditionEdge', 'agentClassifierEdge', 'branchEdge'];
  const incoming = def.edges.filter((e) => e.target === node.id && EXEC.includes(e.type ?? 'defaultEdge'));
  const outgoing = def.edges.filter((e) => e.source === node.id && EXEC.includes(e.type ?? 'defaultEdge'));
  const branching = isBranching(node);
  const options = branching ? branchOptions(node) : [{ value: undefined, label: 'Next step' }];
  const spec = catalog.byType.get(typeOf(node));
  const reads = readsOf(node, def);
  const row = (edge, other) => h('div', { class: 'conn-row' }, icon(other === 'source' ? 'chevronLeft' : 'chevronRight', 14),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm grow', style: { justifyContent: 'flex-start' }, onClick: () => ctx.onSelectNode?.(other === 'source' ? edge.source : edge.target) }, nameById(other === 'source' ? edge.source : edge.target)),
    edge.branch ? badge(branchOptions(def.nodes.find((n) => n.id === edge.source) ?? node).find((o) => o.value === edge.branch)?.label ?? edge.branch, 'neutral') : null,
    button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove this connection', onClick: () => ctx.onDisconnect?.(edge.id) }));
  const picker = (option) => {
    const candidates = def.nodes.filter((n) => n.id !== node.id && !ctx.connectionProblem?.(node.id, n.id, option.value));
    let chosen = '';
    return h('div', { class: 'row', style: { gap: '6px' } },
      select([{ value: '', label: candidates.length ? `Connect ${branching ? `“${option.label}”` : 'to'}…` : 'No compatible steps' }, ...candidates.map((n) => ({ value: n.id, label: nodeName(n, catalog) }))], '', (v) => (chosen = v), { 'aria-label': `Connect ${option.label} to a step`, disabled: !candidates.length }),
      button('Connect', { size: 'sm', disabled: !candidates.length, onClick: () => chosen && ctx.onConnect?.(node.id, chosen, option.value) }),
      button('', { icon: 'plus', size: 'sm', kind: 'ghost', title: 'Add a new step here', onClick: () => ctx.onAddAfter?.(node.id, option.value) }));
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Connect steps without dragging. Steps run after the steps that point to them.'),
    isTrigger(node, catalog) ? h('div', { class: 'callout' }, icon('info'), 'This trigger starts the workflow, so nothing connects into it.') : h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, 'Runs after'), incoming.length ? h('div', { class: 'conn-list' }, incoming.map((e) => row(e, 'source'))) : h('p', { class: 'muted small' }, 'Nothing yet. This step will not run until a step connects to it.')),
    spec?.kind === 'response' ? null : h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, 'Then runs'),
      outgoing.length ? h('div', { class: 'conn-list' }, outgoing.map((e) => row(e, 'target'))) : h('p', { class: 'muted small' }, 'Nothing yet.'),
      ...options.map(picker)),
    h('div', { class: 'io-labels' },
      h('div', { class: 'io-box' }, h('h4', {}, 'Reads'), reads.length ? reads.map((r) => h('div', { class: 'io-ref', title: r.exists ? `From ${nameById(r.id)}` : 'This step does not exist' }, r.exists ? icon('check', 12) : icon('alert', 12), h('code', {}, r.ref))) : h('div', { class: 'small muted' }, 'No references to earlier steps.')),
      h('div', { class: 'io-box' }, h('h4', {}, 'Provides'), [`${node.id}.output`, ...outputPaths(node, catalog).map((p) => `${node.id}.output.${p}`)].slice(0, 8).map((ref) => h('div', { class: 'io-ref' }, h('code', { title: `{{${ref}}}` }, `{{${ref}}}`), copyButton(`{{${ref}}}`))))));
}

export function renderConfig(container, ctx) {
  const { node, catalog } = ctx;
  const spec = catalog.byType.get(typeOf(node));
  let tab = ctx.tab ?? 'config';
  let showAdvanced = false;
  const body = h('div', { class: 'panel-body' });
  const draw = () => {
    clear(body);
    const run = ctx.lastRun?.(node.id);
    body.append(tabs([{ id: 'config', label: 'Configure' }, { id: 'connections', label: 'Connections' }, { id: 'output', label: run ? `Last run · ${run.status}` : 'Last run' }, { id: 'logic', label: 'Retry & timeout' }, { id: 'about', label: 'About' }], tab, (t) => { tab = t; ctx.onTab?.(t); draw(); }));
    if (tab === 'config') {
      if (!spec) {
        body.append(h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, `Jasmine has no runtime for “${typeOf(node)}”.`), h('p', {}, 'Replace this step, or deploying will fail with a clear error.'))), jsonPanel(node.data.values, 'Values'));
        return;
      }
      body.append(h('p', { class: 'small muted', style: { margin: 0 } }, spec.summary ?? spec.description));
      const visible = spec.fields.filter((f) => !f.showIf || f.showIf.equals.map(String).includes(String(node.data.values[f.showIf.key] ?? spec.fields.find((x) => x.key === f.showIf.key)?.options?.[0]?.value ?? '')));
      const basic = visible.filter((f) => !f.advanced);
      const advanced = visible.filter((f) => f.advanced);
      const fieldDiag = (f) => (ctx.diagnostics ?? []).find((d) => new RegExp(`\\b${f.key}\\b`).test(d.message) && d.severity === 'error');
      const fieldEl = (f) => {
        const el = field(f.label, editorFor(f, node, ctx, draw), f.help, { required: f.required });
        const diag = fieldDiag(f);
        const missing = f.required && isEmpty(node.data.values[f.key]) && f.type !== 'boolean';
        if (missing || diag) {
          el.classList.add('invalid');
          el.append(h('span', { class: 'field-error', role: 'alert' }, icon('alert', 12), diag?.message ?? 'Required. Fill this in before testing.'));
        }
        return el;
      };
      if (!basic.length && !advanced.length) body.append(h('p', { class: 'muted' }, 'This step has no settings.'));
      body.append(...basic.map(fieldEl));
      if (advanced.length) {
        body.append(button(showAdvanced ? 'Hide advanced settings' : `Advanced settings (${advanced.length})`, { kind: 'ghost', size: 'sm', icon: showAdvanced ? 'chevronDown' : 'chevronRight', onClick: () => { showAdvanced = !showAdvanced; draw(); } }));
        if (showAdvanced) body.append(...advanced.map(fieldEl));
      }
      const general = (ctx.diagnostics ?? []).filter((d) => !spec.fields.some((f) => fieldDiag(f) === d));
      if (general.length) body.prepend(...general.map((d) => h('div', { class: `diag diag-${d.severity}`, role: d.severity === 'error' ? 'alert' : undefined }, icon(d.severity === 'error' ? 'alert' : 'info', 14), h('span', {}, d.message))));
      if (ctx.setup?.length) body.prepend(...ctx.setup.map((r) => h('div', { class: `diag diag-${r.status === 'missing' ? 'error' : 'warning'}` }, icon('alert', 14), h('div', { class: 'grow' }, h('strong', {}, r.title), h('div', {}, r.detail)), r.action ? h('a', { href: r.action.href, 'data-link': '', class: 'btn btn-sm btn-secondary' }, r.action.label) : null)));
    } else if (tab === 'connections') {
      body.append(connectionsView(ctx));
    } else if (tab === 'output') {
      if (!run) body.append(h('p', { class: 'muted' }, 'Test the workflow to see what this step received and produced.'));
      else {
        body.append(h('div', { class: 'row' }, badge(run.status, run.status === 'success' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral'), h('span', { class: 'muted small' }, run.durationMs !== undefined ? `${Math.round(run.durationMs)} ms` : ''), run.attempts > 1 ? badge(`${run.attempts} attempts`, 'warning') : null,
          run.usage && (run.usage.inputTokens || run.usage.outputTokens) ? h('span', { class: 'muted small' }, `${(run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)} tokens`) : null));
        const explanation = ctx.explanation?.(node.id);
        if (explanation) body.append(explanationCard(explanation));
        else if (run.error) body.append(h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, run.error.code), h('p', {}, run.error.message))));
        if (run.output !== undefined) body.append(jsonPanel(run.output, 'Output'));
      }
    } else if (tab === 'logic') {
      const logic = node.data.engineLogic ?? {};
      const retry = logic.retry ?? { maxAttempts: 1, delayMs: 0, backoff: 'fixed', jitter: false };
      const write = (next) => {
        const clean = { ...next };
        if (!clean.retry || clean.retry.maxAttempts <= 1) delete clean.retry;
        if (!clean.timeoutMs) delete clean.timeoutMs;
        if (Object.keys(clean).length) node.data.engineLogic = clean;
        else delete node.data.engineLogic;
        ctx.onChange();
      };
      body.append(
        h('p', { class: 'muted small' }, 'Retries apply to temporary failures (timeouts, rate limits, server errors). Steps that change other systems (POST requests, messages) only retry when marked idempotent, so they never send twice by accident.'),
        field('Attempts', input(retry.maxAttempts, (v) => write({ ...logic, retry: { ...retry, maxAttempts: Math.min(Math.max(Number(v) || 1, 1), 10) } }), { type: 'number', min: 1, max: 10 })),
        field('Delay between attempts (ms)', input(retry.delayMs, (v) => write({ ...logic, retry: { ...retry, delayMs: Math.min(Math.max(Number(v) || 0, 0), 30000) } }), { type: 'number', min: 0, max: 30000 })),
        field('Backoff', select([{ value: 'fixed', label: 'Fixed' }, { value: 'exponential', label: 'Exponential' }], retry.backoff, (v) => write({ ...logic, retry: { ...retry, backoff: v } }))),
        field('Timeout (ms, empty = run deadline)', input(logic.timeoutMs ?? '', (v) => write({ ...logic, timeoutMs: Number(v) > 0 ? Math.trunc(Number(v)) : undefined }), { type: 'number', min: 1 })));
    } else {
      append(body, [h('p', {}, spec?.summary ?? ''), spec?.summary !== spec?.description ? h('p', { class: 'muted small' }, spec?.description ?? '') : null, h('div', { class: 'field-label' }, 'Outputs'),
        h('div', { class: 'stack-sm' }, (spec?.outputs ?? []).map((o) => h('div', {}, h('code', {}, `{{${node.id}.output.${o.path}}}`), o.description ? h('div', { class: 'muted small' }, o.description) : null))),
        h('div', { class: 'field-label' }, 'Step id'), h('code', {}, node.id), h('div', { class: 'field-label' }, 'Type'), h('code', {}, typeOf(node))]);
    }
  };
  const nameInput = h('input', { class: 'input', value: nodeName(node, catalog), 'aria-label': 'Step name', onInput: (e) => { node.data.values.nodeName = e.target.value; ctx.onChange(); } });
  fill(container,
    h('div', { class: 'panel-head' }, nodeIcon(spec ?? { category: 'app', icon: 'app' }), h('div', { class: 'grow' }, nameInput),
      ctx.onDuplicate ? button('', { icon: 'copy', kind: 'ghost', size: 'sm', title: 'Duplicate step (Ctrl+D)', onClick: ctx.onDuplicate }) : null,
      button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete step (Delete)', onClick: ctx.onDelete }),
      button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Close panel (Esc)', onClick: ctx.onClose })),
    body);
  draw();
}
