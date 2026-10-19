import { assistantPanel } from '../builder/assistant.js';
import { api, catalog as loadCatalog } from '../api.js';
import { Canvas } from '../builder/canvas.js';
import { createLookups, renderConfig } from '../builder/config.js';
import { addNode, autoLayout, connect, connectionProblem, duplicateNode, hasOverlap, isTrigger, nodeName, normalize, removeEdge, removeNode, runOrder, suggestedNext, triggerOf, typeOf } from '../builder/graph.js';
import { createTester } from '../builder/test.js';
import { CATEGORY, lifecycleBadge, nodeIcon, origin, statusList, TRIGGER_LABEL } from '../shared.js';
import { badge, busy, button, clear, confirmDialog, debounce, downloadFile, emptyState, fill, h, icon, modal, pretty, timeAgo, toast } from '../ui.js';

const SHORTCUTS = [
  ['A or /', 'Add a step (after the selected one)'], ['Enter', 'Configure the focused step'], ['Arrow keys', 'Move the selected step (Shift: faster)'],
  ['Delete', 'Delete the selected step or connection'], ['Ctrl/⌘ + D', 'Duplicate the selected step'], ['Ctrl/⌘ + Z', 'Undo'], ['Ctrl/⌘ + Shift + Z or Ctrl + Y', 'Redo'],
  ['Ctrl/⌘ + S', 'Save now'], ['Ctrl/⌘ + Enter', 'Run a test'], ['F', 'Fit the workflow to the screen'], ['+ / − / 0', 'Zoom in, out, or reset to 100%'],
  ['L', 'Switch between canvas and list view'], ['?', 'Show these shortcuts'], ['Esc', 'Close the open panel or palette'],
];

export async function render(container, { id }, { navigate, query }) {
  const [catalog, flow] = await Promise.all([loadCatalog(), api.get(`/api/flows/${encodeURIComponent(id)}`)]);
  const lookups = createLookups();
  let def = normalize(flow.definition, catalog);
  let revision = flow.revision;
  let name = flow.name;
  let summary = flow.summary;
  let dirty = false;
  let saving = null;
  let conflict = false;
  let lastSavedAt = flow.updatedAt;
  const undo = [];
  const redo = [];
  let lastCheckpoint = { kind: '', at: 0 };
  let selected = null;
  let panel = null;
  let diagnostics = [];
  let readiness = null;
  let nodeOutputs = new Map();
  let configTab = 'config';
  let view = matchMedia?.('(max-width: 760px)').matches ? 'list' : 'canvas';
  const BACKUP = `jasmine.draft.${id}`;

  /* ---------- toolbar ---------- */
  const saveState = h('button', { type: 'button', class: 'save-state btn-ghost', style: { border: 'none', cursor: 'pointer', font: 'inherit' }, 'aria-live': 'polite' });
  const deployBadge = h('span');
  const setupChip = h('span');
  const nameInput = h('input', { class: 'builder-name', value: name, size: Math.min(Math.max(name.length + 1, 12), 36), 'aria-label': 'Workflow name', onInput: (e) => { name = e.target.value; e.target.size = Math.min(Math.max(name.length + 1, 12), 36); document.title = `${name} · Jasmine`; markDirty(false); } });
  const undoBtn = button('', { icon: 'undo', kind: 'ghost', title: 'Undo (Ctrl+Z)', onClick: () => doUndo() });
  const redoBtn = button('', { icon: 'redo', kind: 'ghost', title: 'Redo (Ctrl+Shift+Z)', onClick: () => doRedo() });
  const viewBtn = button('', { icon: 'list', kind: 'ghost', title: 'List view (L)', class: 'bar-collapse', onClick: () => toggleView() });
  const validateBtn = button('Validate', { icon: 'check', class: 'bar-collapse', onClick: () => void validate(true) });
  const bar = h('div', { class: 'builder-bar', role: 'toolbar', 'aria-label': 'Workflow tools' },
    button('', { icon: 'chevronLeft', kind: 'ghost', title: 'Back to workflows', onClick: () => navigate('/flows') }),
    nameInput, deployBadge, saveState, h('span', { class: 'grow' }),
    h('div', { class: 'bar-group' }, undoBtn, redoBtn),
    h('div', { class: 'bar-divider bar-collapse' }),
    h('div', { class: 'bar-group' },
      button('Add step', { icon: 'plus', labelClass: 'bar-label', title: 'Add a step (A)', onClick: () => openPalette(selected ? { after: selected } : {}) }),
      button('', { icon: 'layout', kind: 'ghost', title: 'Tidy layout', class: 'bar-collapse', onClick: () => tidy() }), viewBtn),
    h('div', { class: 'bar-divider bar-collapse' }),
    setupChip,
    button('Copilot', { icon: 'sparkles', class: 'bar-collapse', title: 'Ask the copilot about this workflow', onClick: () => openAssistant() }),
    validateBtn,
    button('Test', { icon: 'play', title: 'Test the draft (Ctrl+Enter)', onClick: () => openPanel('test') }),
    button('', { icon: 'menu', kind: 'ghost', title: 'More', onClick: () => moreMenu() }),
    button('Deploy', { icon: 'deploy', kind: 'primary', title: 'Review and deploy', onClick: () => void deploy() }));
  const canvasHost = h('div', { style: { position: 'relative', minWidth: '0', minHeight: '0', display: 'grid' } });
  const side = h('aside', { class: 'panel hidden', 'aria-label': 'Inspector' });
  const root = h('div', { class: 'builder', 'data-page-title': name }, bar, h('div', { class: 'builder-body' }, canvasHost, side));
  container.append(root);

  const canvas = new Canvas(canvasHost, {
    catalog,
    hooks: {
      select: (nodeId) => {
        selected = nodeId;
        if (nodeId) openPanel('node');
        else if (panel === 'node') closePanel();
      },
      open: (nodeId) => { selected = nodeId; openPanel('node'); },
      selectEdge: () => { canvas.showHint('Connection selected. Press Delete to remove it.', 3000); },
      beforeMove: () => checkpoint('move'),
      move: () => markDirty(),
      moveNote: () => markDirty(),
      editNote: (i) => editNote(i),
      canConnect: (source, target, branch) => connectionProblem(def, catalog, source, target, branch),
      connect: (source, target, branch) => doConnect(source, target, branch),
      addAfter: (nodeId, branch, at) => openPalette({ after: nodeId, branch, at }),
      deleteNode: (nodeId) => deleteNode(nodeId),
      deleteEdge: (edgeId) => {
        checkpoint();
        removeEdge(def, edgeId);
        canvas.setDefinition(def);
        markDirty();
      },
      viewport: (v) => { def.viewport = { x: v.x, y: v.y, zoom: v.zoom }; },
    },
  });
  const outline = h('div', { class: 'outline hidden', role: 'region', 'aria-label': 'Workflow steps (list view)' });
  canvasHost.append(outline);
  canvas.setDefinition(def);
  if (def.viewport && Number.isFinite(def.viewport.zoom)) canvas.setView(def.viewport);
  else setTimeout(() => canvas.fit(), 30);

  const emptyHint = h('div', { class: 'canvas-empty' }, emptyState('flows', 'Start with a trigger', 'Every workflow begins with a trigger: an API request, chat message, webhook, schedule or file. Then add the steps it should take.',
    h('div', { class: 'row row-wrap', style: { justifyContent: 'center' } }, button('Add a trigger', { kind: 'primary', icon: 'plus', onClick: () => openPalette({ triggersOnly: true }) }), h('a', { href: '/', 'data-link': '', class: 'btn btn-secondary' }, 'Describe it instead'))));
  const refreshEmpty = () => {
    emptyHint.remove();
    if (!def.nodes.length && view === 'canvas') canvasHost.append(emptyHint);
  };
  refreshEmpty();

  /* ---------- status ---------- */
  const setSave = (kind, detail) => {
    saveState.className = `save-state ${kind}`;
    const states = {
      saved: [icon('checkCircle', 13), 'Saved'], saving: [h('span', { class: 'spinner', style: { width: '11px', height: '11px' } }), 'Saving…'], dirty: [icon('dot', 13), 'Unsaved changes'],
      offline: [icon('wifiOff', 13), 'Offline · kept in this browser'], error: [icon('alert', 13), 'Not saved · retrying'], conflict: [icon('alert', 13), 'Changed elsewhere'],
    };
    fill(saveState, ...(states[kind] ?? states.saved));
    saveState.title = kind === 'saved' ? `All changes saved ${lastSavedAt ? timeAgo(lastSavedAt) : ''}` : kind === 'conflict' ? 'Click to resolve' : kind === 'error' || kind === 'offline' ? `${detail ?? ''} Click to retry now.` : '';
  };
  saveState.addEventListener('click', () => { if (conflict) showConflict(); else void save(); });
  setSave('saved');

  const updateBadges = () => {
    fill(deployBadge, summary ? lifecycleBadge({ ...summary, draftChanged: summary.draftChanged || (dirty && !!summary.deployedVersion) }) : null);
  };
  updateBadges();
  const updateHistoryButtons = () => {
    undoBtn.disabled = !undo.length;
    redoBtn.disabled = !redo.length;
  };
  updateHistoryButtons();

  const paintChecks = () => {
    canvas.setErrors(new Map(diagnostics.filter((d) => d.severity === 'error' && d.nodeId).map((d) => [d.nodeId, d.message])));
    const flags = new Map();
    for (const r of readiness?.requirements ?? []) if (r.status === 'missing' || r.status === 'warning') for (const nid of r.nodeIds ?? []) if (!flags.has(nid)) flags.set(nid, r.title);
    canvas.setFlags(flags);
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const missing = readiness?.missing ?? 0;
    const count = errors + missing;
    fill(setupChip, readiness || diagnostics.length ? button(count ? `${count} to fix` : 'Ready to test', { size: 'sm', kind: 'ghost', icon: count ? 'alert' : 'checkCircle', title: 'Validation and setup checks', class: 'bar-collapse', attrs: { style: `color: var(--${count ? 'warning' : 'success'})` }, onClick: () => openPanel('issues') }) : null);
    fill(validateBtn, icon('check', 16), h('span', {}, errors ? `Validate (${errors})` : 'Validate'));
    if (panel === 'issues') openPanel('issues');
    if (view === 'list') drawOutline();
  };

  let lastReadiness = 0;
  const runChecks = debounce(async () => {
    try {
      const wantReadiness = Date.now() - lastReadiness > 8000;
      const [v, r] = await Promise.all([
        api.post(`/api/flows/${encodeURIComponent(id)}/validate`, { definition: def }),
        wantReadiness ? api.post('/api/readiness', { definition: def }) : Promise.resolve(readiness),
      ]);
      diagnostics = v.diagnostics ?? [];
      if (wantReadiness) { readiness = r; lastReadiness = Date.now(); }
      paintChecks();
    } catch { /* checks are advisory; saving is what matters */ }
  }, 900);

  /* ---------- saving, backup and recovery ---------- */
  const backup = () => { try { localStorage.setItem(BACKUP, JSON.stringify({ baseRevision: revision, at: Date.now(), name, definition: def })); } catch { /* storage full or blocked */ } };
  const clearBackup = () => { try { localStorage.removeItem(BACKUP); } catch { /* optional */ } };
  let retryTimer = null;
  let retryDelay = 2000;

  const save = async () => {
    if (conflict) return;
    if (saving) await saving;
    if (!dirty) return;
    clearTimeout(retryTimer);
    dirty = false;
    setSave('saving');
    const snapshot = structuredClone(def);
    saving = api.put(`/api/flows/${encodeURIComponent(id)}`, { name: name.trim() || 'Untitled workflow', definition: snapshot, expectedRevision: revision }).then((saved) => {
      revision = saved.revision;
      summary = saved.summary;
      lastSavedAt = saved.updatedAt;
      retryDelay = 2000;
      if (dirty) setSave('dirty');
      else { setSave('saved'); clearBackup(); }
      updateBadges();
      runChecks();
    }).catch((e) => {
      if (e.status === 409) {
        conflict = true;
        dirty = true;
        setSave('conflict');
        showConflict();
      } else {
        dirty = true;
        setSave(e.status === 0 ? 'offline' : 'error', e.message);
        retryTimer = setTimeout(() => void save(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    }).finally(() => {
      saving = null;
    });
    await saving;
  };
  const scheduleSave = debounce(() => void save(), 700);
  function markDirty(redraw = false) {
    dirty = true;
    if (!conflict) setSave('dirty');
    updateBadges();
    backup();
    if (redraw) canvas.setDefinition(def);
    refreshEmpty();
    if (view === 'list') drawOutline();
    scheduleSave();
  }

  function showConflict() {
    modal({
      title: 'This workflow changed elsewhere',
      body: h('div', { class: 'stack' }, h('p', {}, 'Someone (or another tab, or the copilot) saved a newer version while you were editing. Your edits are kept in this browser until you choose.'),
        h('ul', { class: 'small', style: { color: 'var(--text-2)', margin: 0, paddingLeft: '18px' } }, h('li', {}, h('strong', {}, 'Load the latest'), ' replaces your unsaved edits with the saved version.'), h('li', {}, h('strong', {}, 'Keep mine'), ' saves your version on top of the newer one.'))),
      actions: [
        { label: 'Load the latest', onClick: async (close) => {
          const latest = await api.get(`/api/flows/${encodeURIComponent(id)}`);
          checkpoint();
          def = normalize(latest.definition, catalog); revision = latest.revision; name = latest.name; nameInput.value = name; summary = latest.summary;
          conflict = false; dirty = false; clearBackup(); canvas.setDefinition(def); setSave('saved'); updateBadges(); close(); runChecks();
        } },
        { label: 'Keep mine', kind: 'primary', onClick: async (close) => {
          const latest = await api.get(`/api/flows/${encodeURIComponent(id)}`);
          revision = latest.revision; conflict = false; dirty = true; close(); await save();
        } },
      ],
    });
  }

  // Unsaved edits from an earlier session (browser crash, lost connection) come back on request.
  try {
    const saved = JSON.parse(localStorage.getItem(BACKUP) ?? 'null');
    if (saved?.definition && JSON.stringify(normalize(saved.definition, catalog)) !== JSON.stringify(def)) {
      const newer = saved.baseRevision !== revision;
      const banner = h('div', { class: 'canvas-hint', role: 'alert', style: { top: '14px' } }, icon('history', 15),
        h('span', {}, `Unsaved changes from ${timeAgo(new Date(saved.at).toISOString())} were found in this browser${newer ? ' (the saved workflow has changed since)' : ''}.`),
        button('Restore', { size: 'sm', kind: 'primary', onClick: () => { checkpoint(); def = normalize(saved.definition, catalog); if (saved.name) { name = saved.name; nameInput.value = name; } canvas.setDefinition(def); banner.remove(); markDirty(); toast('Your unsaved changes were restored', 'success'); } }),
        button('Discard', { size: 'sm', kind: 'ghost', onClick: () => { clearBackup(); banner.remove(); } }));
      canvasHost.append(banner);
    } else clearBackup();
  } catch { /* storage is optional */ }

  function checkpoint(kind = '') {
    const now = Date.now();
    // Bursts of the same small edit (arrow-key nudges) collapse into one undo step.
    if (kind && lastCheckpoint.kind === kind && now - lastCheckpoint.at < 1000) { lastCheckpoint.at = now; return; }
    lastCheckpoint = { kind, at: now };
    undo.push(JSON.stringify(def));
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    updateHistoryButtons();
  }
  function doUndo() {
    if (!undo.length) return;
    redo.push(JSON.stringify(def));
    def = JSON.parse(undo.pop());
    afterHistory();
  }
  function doRedo() {
    if (!redo.length) return;
    undo.push(JSON.stringify(def));
    def = JSON.parse(redo.pop());
    afterHistory();
  }
  function afterHistory() {
    canvas.setDefinition(def);
    updateHistoryButtons();
    if (selected && !def.nodes.some((n) => n.id === selected)) closePanel();
    else if (panel === 'node') openPanel('node');
    markDirty();
  }

  /* ---------- editing operations ---------- */
  function doConnect(source, target, branch) {
    const problem = connectionProblem(def, catalog, source, target, branch);
    if (problem) {
      toast(problem, 'error');
      return false;
    }
    checkpoint();
    if (connect(def, catalog, source, target, branch)) {
      canvas.setDefinition(def);
      markDirty();
      return true;
    }
    return false;
  }
  function deleteNode(nodeId) {
    const node = def.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    checkpoint();
    removeNode(def, nodeId);
    canvas.setDefinition(def);
    if (selected === nodeId) closePanel();
    markDirty();
    toast(`Deleted “${nodeName(node, catalog)}”. Press Ctrl+Z to undo.`, 'info', 3500);
  }
  const heights = () => new Map([...canvas.sizes()].map(([nid, size]) => [nid, size.h]));
  function tidy() {
    checkpoint();
    autoLayout(def, heights());
    canvas.setDefinition(def);
    setTimeout(() => canvas.fit(true), 30);
    markDirty();
  }
  function toggleView() {
    view = view === 'canvas' ? 'list' : 'canvas';
    outline.classList.toggle('hidden', view !== 'list');
    canvasHost.classList.toggle('list-view', view === 'list');
    fill(viewBtn, icon(view === 'list' ? 'flows' : 'list', 16));
    viewBtn.title = view === 'list' ? 'Canvas view (L)' : 'List view (L)';
    refreshEmpty();
    if (view === 'list') drawOutline();
  }

  function drawOutline() {
    const order = runOrder(def).filter(Boolean);
    const errors = new Map(diagnostics.filter((d) => d.severity === 'error' && d.nodeId).map((d) => [d.nodeId, d.message]));
    const flags = new Map();
    for (const r of readiness?.requirements ?? []) if (r.status === 'missing' || r.status === 'warning') for (const nid of r.nodeIds ?? []) if (!flags.has(nid)) flags.set(nid, r.title);
    const name = (nid) => { const n = def.nodes.find((x) => x.id === nid); return n ? nodeName(n, catalog) : nid; };
    const items = [];
    order.forEach((n, i) => {
      const spec = catalog.byType.get(typeOf(n));
      const ins = def.edges.filter((e) => e.target === n.id && !['loopEdge', 'agentLoopEdge', 'responseEdge'].includes(e.type)).map((e) => name(e.source));
      const outs = def.edges.filter((e) => e.source === n.id && !['loopEdge', 'agentLoopEdge', 'responseEdge'].includes(e.type)).map((e) => name(e.target));
      if (i) items.push(h('li', { class: 'outline-link', 'aria-hidden': 'true' }));
      items.push(h('li', { class: ['outline-item', selected === n.id ? 'selected' : ''] },
        nodeIcon(spec ?? { category: 'app', icon: 'app' }, 32),
        h('div', { class: 'grow' },
          h('div', { class: 'row row-wrap' }, h('strong', {}, `${i + 1}. ${nodeName(n, catalog)}`), h('span', { class: 'muted small' }, spec?.label ?? typeOf(n)),
            errors.get(n.id) ? badge('Fix configuration', 'danger') : flags.get(n.id) ? badge('Needs setup', 'warning') : null),
          h('p', {}, spec?.summary ?? spec?.description ?? ''),
          h('p', { class: 'small muted' }, isTrigger(n, catalog) ? 'Starts the workflow' : ins.length ? `After: ${ins.join(', ')}` : 'Not connected yet', outs.length ? ` · Then: ${outs.join(', ')}` : '')),
        h('div', { class: 'stack-sm' },
          button('Configure', { size: 'sm', onClick: () => { selected = n.id; canvas.select(n.id); openPanel('node'); } }),
          spec?.kind === 'response' ? null : button('Add after', { size: 'sm', kind: 'ghost', icon: 'plus', onClick: () => openPalette({ after: n.id }) }))));
    });
    fill(outline, def.nodes.length
      ? h('div', { class: 'stack', style: { maxWidth: '720px', margin: '0 auto' } }, h('div', { class: 'row spread' }, h('h2', {}, 'Steps in run order'), button('Add step', { size: 'sm', icon: 'plus', onClick: () => openPalette(order.length ? { after: order.at(-1).id } : { triggersOnly: true }) })), h('ol', { class: 'outline-list' }, items))
      : emptyState('flows', 'No steps yet', 'Add a trigger to start.', button('Add a trigger', { kind: 'primary', icon: 'plus', onClick: () => openPalette({ triggersOnly: true }) })));
  }
  outline.classList.toggle('hidden', view !== 'list');
  canvasHost.classList.toggle('list-view', view === 'list');
  if (view === 'list') { fill(viewBtn, icon('flows', 16)); viewBtn.title = 'Canvas view (L)'; drawOutline(); }

  /* ---------- panels ---------- */
  let tester = null;
  function closePanel() {
    panel = null;
    selected = null;
    canvas.select(null);
    side.classList.add('hidden');
    clear(side);
  }
  const onNodeChange = debounce(() => { canvas.redrawNode(selected); if (view === 'list') drawOutline(); }, 250);
  const panelHead = (iconName, title, extra) => h('div', { class: 'panel-head' }, icon(iconName), h('strong', { class: 'grow' }, title), extra ?? null, button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Close (Esc)', onClick: () => closePanel() }));

  function openAssistant() {
    panel = 'assistant';
    side.classList.remove('hidden');
    const focus = def.nodes.find((n) => n.id === selected);
    fill(side, panelHead('sparkles', focus ? `Copilot · ${nodeName(focus, catalog)}` : 'Copilot'),
      assistantPanel({
        flowId: id, nodeId: selected, prepare: () => save(), getRevision: () => revision,
        nameOf: (nid) => { const n = def.nodes.find((x) => x.id === nid); return n ? nodeName(n, catalog) : nid; },
        onSelectNode: (nid) => { selected = nid; canvas.select(nid); canvas.centerOn(nid); },
        onApplied: (saved) => {
          checkpoint();
          def = normalize(saved.definition, catalog);
          revision = saved.revision;
          if (saved.summary) summary = saved.summary;
          dirty = false; conflict = false; clearBackup();
          canvas.setDefinition(def);
          setSave('saved');
          updateBadges();
          runChecks();
          if (view === 'list') drawOutline();
        },
      }));
  }
  function editTags() {
    let value = (def.meta?.tags ?? []).join(', ');
    const control = h('input', { class: 'input', value, 'aria-label': 'Tags, separated by commas', onInput: (e) => (value = e.target.value) });
    modal({ title: 'Workflow tags', body: h('div', { class: 'stack-sm' }, control, h('p', { class: 'small muted' }, 'Separate tags with commas. Tags help you search your workflows.')), actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Save', kind: 'primary', onClick: (close) => { checkpoint(); def.meta = { ...def.meta, tags: [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))].slice(0, 20) }; markDirty(); close(); } }] });
  }

  function openPanel(kind) {
    panel = kind;
    side.classList.remove('hidden');
    if (kind === 'node') {
      const node = def.nodes.find((n) => n.id === selected);
      if (!node) return closePanel();
      canvas.select(node.id);
      let changed = false;
      renderConfig(side, {
        node, def, catalog, lookups, flowId: id, tab: configTab, toast, modal, onTab: (t) => (configTab = t),
        diagnostics: diagnostics.filter((d) => d.nodeId === node.id),
        setup: (readiness?.requirements ?? []).filter((r) => (r.status === 'missing' || r.status === 'warning') && r.nodeIds?.includes(node.id)),
        lastRun: (nodeId) => nodeOutputs.get(nodeId),
        explanation: (nodeId) => nodeOutputs.get(nodeId)?.explanation,
        connectionProblem: (s, t, b) => connectionProblem(def, catalog, s, t, b),
        onConnect: (s, t, b) => { if (doConnect(s, t, b)) openPanel('node'); },
        onDisconnect: (edgeId) => { checkpoint(); removeEdge(def, edgeId); canvas.setDefinition(def); markDirty(); openPanel('node'); },
        onAddAfter: (nodeId, branch) => openPalette({ after: nodeId, branch }),
        onSelectNode: (nid) => { selected = nid; canvas.centerOn(nid); openPanel('node'); },
        onChange: () => {
          if (!changed) {
            checkpoint();
            changed = true;
            setTimeout(() => (changed = false), 1500);
          }
          markDirty();
          onNodeChange();
        },
        onDelete: () => deleteNode(node.id),
        onDuplicate: () => duplicate(node.id),
        onClose: () => closePanel(),
      });
    } else if (kind === 'test') {
      tester ??= createTester({
        flowId: id, catalog, getDefinition: () => def,
        beforeRun: () => save(),
        onStatuses: (map) => canvas.setStatuses(map),
        onNodeOutputs: (map) => (nodeOutputs = map),
        onSelectNode: (nodeId) => { selected = nodeId; configTab = 'output'; canvas.centerOn(nodeId); openPanel('node'); },
      });
      tester.refresh();
      fill(side, panelHead('play', 'Test', h('span', { class: 'muted small' }, 'Runs the current draft')), tester.el);
      canvasHost.querySelector('.draft-hint')?.remove();
      requestAnimationFrame(() => canvas.keepInView());
    } else if (kind === 'issues') {
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');
      const showNode = (d) => { if (d.nodeId && def.nodes.some((n) => n.id === d.nodeId)) { selected = d.nodeId; canvas.centerOn(d.nodeId); openPanel('node'); } };
      fill(side, panelHead('check', 'Checks'),
        h('div', { class: 'panel-body' },
          h('div', { class: 'field-label' }, 'Validation'),
          errors.length || warnings.length
            ? [...errors, ...warnings].map((d) => { const target = def.nodes.find((n) => n.id === d.nodeId); return h('div', { class: `diag diag-${d.severity}`, role: 'button', tabindex: 0, onClick: () => showNode(d), onKeydown: (e) => { if (e.key === 'Enter') showNode(d); } }, icon(d.severity === 'error' ? 'alert' : 'info', 14), h('div', {}, h('strong', {}, target ? nodeName(target, catalog) : d.nodeId ?? 'Workflow'), h('div', {}, d.message), h('div', { class: 'small', style: { opacity: 0.8 } }, d.code))); })
            : h('div', { class: 'callout callout-success' }, icon('check'), 'No configuration problems found.'),
          h('div', { class: 'field-label' }, 'Setup'),
          readiness ? (readiness.requirements.length ? statusList(readiness.requirements, { compact: true }) : h('p', { class: 'muted small' }, 'This workflow needs no models, knowledge or credentials.')) : h('div', { class: 'row muted small' }, h('span', { class: 'spinner' }), 'Checking models, knowledge and credentials…'),
          button('Ask the copilot why', { size: 'sm', icon: 'sparkles', onClick: () => openAssistant() })));
    }
  }

  function duplicate(nodeId) {
    checkpoint();
    const copy = duplicateNode(def, nodeId);
    if (copy) {
      canvas.setDefinition(def);
      selected = copy.id;
      openPanel('node');
      markDirty();
    } else toast('Loop and agent steps cannot be duplicated on their own', 'info');
  }

  /* ---------- palette ---------- */
  let palette = null;
  const closePalette = () => { palette?.remove(); palette = null; };
  function openPalette({ after, branch, at, triggersOnly } = {}) {
    closePalette();
    const hasTrigger = !!triggerOf(def, catalog);
    if (!hasTrigger && !after) triggersOnly = true;
    const items = catalog.list.filter((n) => !n.hidden && (triggersOnly ? n.kind === 'trigger' : !(n.kind === 'trigger' && hasTrigger)) && !(after && n.kind === 'trigger'));
    const source = after ? def.nodes.find((n) => n.id === after) : null;
    const suggestions = source ? suggestedNext(def, catalog, source) : [];
    const search = h('input', { class: 'input', placeholder: triggersOnly ? 'How should this workflow start?' : 'Search steps, e.g. “summarize”, “pdf”, “slack”…', 'aria-label': 'Search steps', role: 'combobox', 'aria-controls': 'palette-list', 'aria-expanded': 'true', autocomplete: 'off' });
    const list = h('div', { class: 'palette-list', role: 'listbox', id: 'palette-list', 'aria-label': 'Steps' });
    const order = ['trigger', 'ai', 'rag', 'data', 'logic', 'app', 'response'];
    let active = 0;
    let options = [];
    const matches = (n, q) => !q || `${n.label} ${n.summary ?? ''} ${n.description} ${n.type} ${(n.keywords ?? []).join(' ')}`.toLowerCase().includes(q);
    const draw = () => {
      const q = search.value.toLowerCase().trim();
      clear(list);
      options = [];
      const group = (title, nodes) => {
        if (!nodes.length) return;
        list.append(h('div', { class: 'palette-group', role: 'presentation' }, title));
        for (const n of nodes) {
          const index = options.length;
          const item = h('button', { type: 'button', class: ['palette-item', index === active ? 'active' : ''], role: 'option', id: `pal-${index}`, 'aria-selected': index === active ? 'true' : 'false', onClick: () => place(n.type) },
            nodeIcon(n, 28), h('span', {}, h('strong', { class: 'pal-label' }, n.label), h('small', {}, n.summary ?? n.description)));
          options.push({ type: n.type, el: item });
          list.append(item);
        }
      };
      if (!q && suggestions.length) group('Suggested next', suggestions.map((t) => catalog.byType.get(t)).filter((n) => n && items.includes(n)));
      for (const cat of order) group(CATEGORY[cat]?.label ?? cat, items.filter((n) => n.category === cat && matches(n, q) && !(!q && suggestions.includes(n.type))));
      if (!options.length) list.append(h('p', { class: 'muted', style: { padding: '12px' } }, 'No matching steps. Try another word, or ask the copilot.'));
      active = Math.min(active, Math.max(options.length - 1, 0));
      search.setAttribute('aria-activedescendant', options.length ? `pal-${active}` : '');
    };
    const highlight = () => {
      options.forEach((o, i) => { o.el.classList.toggle('active', i === active); o.el.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
      options[active]?.el.scrollIntoView?.({ block: 'nearest' });
      search.setAttribute('aria-activedescendant', options.length ? `pal-${active}` : '');
    };
    const place = (type) => {
      checkpoint();
      const position = at ?? (source ? { x: source.position.x, y: source.position.y + 190 } : canvas.center());
      const added = addNode(def, catalog, type, { x: Math.round(position.x / 10) * 10, y: Math.round(position.y / 10) * 10 }, after ? { after, branch } : {});
      canvas.setDefinition(def);
      closePalette();
      selected = added[0].id;
      openPanel('node');
      markDirty();
      setTimeout(() => canvas.focusNode(added[0].id), 0);
    };
    search.addEventListener('input', () => { active = 0; draw(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, options.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
      else if (e.key === 'Enter' && options[active]) { e.preventDefault(); place(options[active].type); }
    });
    palette = h('div', { class: 'palette', role: 'dialog', 'aria-label': triggersOnly ? 'Choose a trigger' : 'Add a step' },
      h('div', { class: 'palette-search row' }, search, button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Close (Esc)', onClick: closePalette })),
      source ? h('div', { class: 'muted small', style: { padding: '8px 14px 0' } }, `Runs after “${nodeName(source, catalog)}”${branch ? ` (${branch})` : ''}. It is wired to that step’s output automatically.`) : triggersOnly ? h('div', { class: 'muted small', style: { padding: '8px 14px 0' } }, 'Every workflow starts with exactly one trigger.') : null,
      list);
    canvasHost.append(palette);
    draw();
    search.focus();
  }

  function editNote(index) {
    const note = def.notes[index];
    const title = h('input', { class: 'input', value: note.title ?? '', 'aria-label': 'Note title' });
    const text = h('textarea', { class: 'input', rows: 6, 'aria-label': 'Note text' });
    text.value = note.text ?? '';
    modal({
      title: 'Edit note', body: h('div', { class: 'stack' }, title, text),
      actions: [
        { label: 'Delete note', kind: 'ghost', icon: 'trash', onClick: (close) => { checkpoint(); def.notes.splice(index, 1); canvas.setDefinition(def); markDirty(); close(); } },
        { label: 'Save', kind: 'primary', onClick: (close) => { checkpoint(); note.title = title.value; note.text = text.value; canvas.setDefinition(def); markDirty(); close(); } },
      ],
    });
  }

  function moreMenu() {
    const narrow = matchMedia?.('(max-width: 760px)').matches;
    const items = [
      ...(narrow ? [['sparkles', 'Copilot', () => openAssistant()], ['check', 'Validate', () => void validate(true)], ['layout', 'Tidy layout', () => tidy()], ['list', view === 'list' ? 'Canvas view' : 'List view', () => toggleView()]] : []),
      ['history', 'Versions & export', () => void openVersions()],
      ['note', 'Add a sticky note', () => { checkpoint(); const c = canvas.center(); def.notes.push({ title: 'Note', text: 'Press Enter or double-click to edit', color: 'yellow', x: Math.round(c.x), y: Math.round(c.y), width: 300 }); canvas.setDefinition(def); markDirty(); }],
      ['edit', 'Tags', () => editTags()],
      ['keyboard', 'Keyboard shortcuts', () => showShortcuts()],
    ];
    let close = () => {};
    const body = h('div', { class: 'command-results' }, items.map(([ico, label, run]) => button(label, { kind: 'ghost', icon: ico, onClick: () => { close(); run(); } })));
    close = modal({ title: 'More', body }).close;
    body.querySelector('button')?.focus();
  }

  function showShortcuts() {
    modal({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv', style: { gap: '8px 16px' } }, SHORTCUTS.flatMap(([keys, what]) => [h('dt', {}, h('span', { class: 'kbd' }, keys)), h('dd', {}, what)])) });
  }

  /* ---------- validate & deploy ---------- */
  async function validate(show) {
    await save();
    const [res, r] = await Promise.all([api.post(`/api/flows/${encodeURIComponent(id)}/validate`, { definition: def }), api.post('/api/readiness', { definition: def }).catch(() => readiness)]);
    diagnostics = res.diagnostics ?? [];
    readiness = r;
    lastReadiness = Date.now();
    paintChecks();
    if (show) openPanel('issues');
    return res.ok;
  }

  function exposure(trigger) {
    const type = typeOf(trigger);
    const v = trigger?.data.values ?? {};
    const base = origin();
    const domains = Array.isArray(v.domains) ? v.domains : ['*'];
    switch (type) {
      case 'chatTriggerNode': case 'askTriggerNode': return { icon: 'globe', text: `A public chat page at ${base}/apps/chat/${id} and an embeddable widget. ${domains.includes('*') ? 'Any website may embed it; limit allowed domains on the trigger before sharing.' : `It can be embedded on ${domains.join(', ')}.`}` };
      case 'searchTriggerNode': return { icon: 'globe', text: `A public search page at ${base}/apps/search/${id} and an embeddable widget.` };
      case 'webhookTriggerNode': return { icon: 'webhook', text: `A webhook at POST ${base}/webhooks/${id}. ${v.webhookSecret ? 'Callers must send the shared secret.' : 'It has no shared secret, so anyone who can reach the runtime can call it.'}` };
      case 'cronNode': return { icon: 'clock', text: `Runs automatically on “${v.cronExpression ?? ''}” (${v.cronTimezone || 'UTC'}) while the runtime is online.` };
      case 'localFolderNode': return { icon: 'folder', text: `Processes new or changed files in ${v.folderPath || 'the chosen folder'} on the runtime.` };
      case 'sourceTriggerNode': return { icon: 'database', text: 'Polls the configured source on its schedule.' };
      case 'mailhookNode': return { icon: 'mail', text: 'Receives email at its inbound address when the runtime’s SMTP listener is enabled.' };
      default: return { icon: 'api', text: `An API endpoint at POST ${base}/api/v1/flows/${id}/execute (and GraphQL). Callers need an API key when keys are configured.` };
    }
  }

  async function deploy() {
    await save();
    if (conflict) return;
    let ok;
    try { ok = await validate(false); } catch (e) { toast(e.message, 'error'); return; }
    if (!ok) {
      openPanel('issues');
      toast('Fix the configuration errors before deploying', 'error');
      return;
    }
    const trigger = triggerOf(def, catalog);
    const what = exposure(trigger);
    const missing = (readiness?.requirements ?? []).filter((r) => r.status === 'missing');
    const confirmed = await new Promise((resolve) => {
      let done = false;
      modal({
        title: `Deploy “${name.trim() || 'Untitled workflow'}”?`,
        body: h('div', { class: 'stack' },
          h('div', { class: 'callout callout-success' }, icon('check'), h('div', {}, h('strong', {}, 'Passes validation'), h('p', {}, `Trigger: ${TRIGGER_LABEL[typeOf(trigger)] ?? catalog.byType.get(typeOf(trigger))?.label ?? 'none'}.`))),
          h('div', { class: 'callout' }, icon(what.icon), h('div', {}, h('strong', {}, 'What becomes live'), h('p', {}, what.text))),
          missing.length ? h('div', { class: 'stack-sm' }, h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, `${missing.length} thing${missing.length === 1 ? ' is' : 's are'} not set up yet`), h('p', {}, 'The deployment will accept requests, but runs fail until these are fixed.'))), statusList(missing, { compact: true })) : null,
          h('p', { class: 'small muted', style: { margin: 0 } }, `${summary?.deployedVersion ? `Replaces the live version ${summary.deployedVersion.slice(0, 12)}. Runs already in progress keep their version.` : 'Creates the first version.'} Every deploy is an immutable version you can roll back to or disable. It runs on your Jasmine runtime${location.origin ? ` behind ${location.origin}` : ''}.`)),
        onClose: () => { if (!done) resolve(false); },
        actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: missing.length ? 'Deploy anyway' : 'Deploy version', kind: 'primary', icon: 'deploy', onClick: (close) => { done = true; resolve(true); close(); } }],
      });
    });
    if (!confirmed) return;
    try {
      const result = await api.post(`/api/flows/${encodeURIComponent(id)}/deploy`, {});
      summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`)).summary;
      updateBadges();
      toast(result.changed ? `Deployed version ${result.version.slice(0, 12)}` : 'Already deployed; nothing changed', 'success');
      modal({
        title: 'It’s live',
        body: h('div', { class: 'stack' }, h('p', {}, `Version ${result.version.slice(0, 12)} is serving requests. Runs started earlier keep the version they started on.`), h('div', { class: 'callout' }, icon(what.icon), h('div', {}, what.text))),
        actions: [{ label: 'Keep editing', onClick: (close) => close() }, { label: 'Endpoints, embed code & test', kind: 'primary', icon: 'deploy', onClick: (close) => { close(); navigate(`/deployments/${encodeURIComponent(id)}`); } }],
      });
    } catch (e) {
      diagnostics = e.diagnostics ?? [{ severity: 'error', code: e.code ?? 'DEPLOY', message: e.message }];
      summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`).catch(() => ({ summary })))?.summary ?? summary;
      updateBadges();
      openPanel('issues');
      toast(`Deploy failed: ${e.message}`, 'error', 8000);
    }
  }

  async function openVersions() {
    const data = await api.get(`/api/flows/${encodeURIComponent(id)}/versions`);
    const body = h('div', { class: 'stack' },
      h('div', { class: 'row row-wrap' },
        button('Export JSON', { icon: 'download', onClick: () => downloadFile(`${id}.json`, pretty({ meta: { name }, ...def })) }),
        summary?.deployedVersion ? button('Disable (undeploy)', { icon: 'stop2', kind: 'ghost', onClick: async () => {
          if (!await confirmDialog('Stop serving this workflow? Its API, webhook, widget and schedule stop working until you deploy again. Versions are kept.', { danger: true, confirmLabel: 'Disable' })) return;
          await api.post(`/api/flows/${encodeURIComponent(id)}/undeploy`);
          summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`)).summary;
          updateBadges();
          toast('Workflow disabled', 'success');
        } }) : null),
      data.versions.length ? h('div', { class: 'stack-sm' }, data.versions.map((v) => h('div', { class: 'row list-item', style: { flexDirection: 'row' } },
        h('code', {}, v.version.slice(0, 12)), v.active ? badge('Live', 'success') : null, h('span', { class: 'muted small grow' }, timeAgo(v.deployedAt)),
        v.active ? null : button('Roll back', { size: 'sm', onClick: async (e) => busy(e.currentTarget, async () => {
          if (!await confirmDialog(`Make version ${v.version.slice(0, 12)} live? New runs use it immediately.`, { confirmLabel: 'Roll back' })) return;
          await api.post(`/api/flows/${encodeURIComponent(id)}/rollback`, { toVersion: v.version });
          toast(`Rolled back to ${v.version.slice(0, 12)}`, 'success');
          summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`)).summary;
          updateBadges();
        }) }),
        button('Restore into draft', { size: 'sm', kind: 'ghost', onClick: async (e) => {
          const version = await api.get(`/api/flows/${encodeURIComponent(id)}/versions/${v.version}`);
          checkpoint();
          def = normalize(version.definition, catalog);
          canvas.setDefinition(def);
          markDirty();
          e.target.closest('dialog')?.dispatchEvent(new Event('cancel'));
          setTimeout(() => canvas.fit(true), 30);
          toast('Version restored into the draft; deploy to make it live', 'info');
        } })))) : h('p', { class: 'muted' }, 'Not deployed yet. Each deploy creates an immutable version you can roll back to.'));
    modal({ title: 'Versions', body, wide: true });
  }

  /* ---------- keyboard ---------- */
  const onKey = (e) => {
    if (e.target.closest?.('dialog')) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      void save();
    } else if (mod && key === 'enter') {
      e.preventDefault();
      openPanel('test');
      tester?.runNow();
    } else if (mod && key === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    } else if (mod && key === 'y' && !typing) {
      e.preventDefault();
      doRedo();
    } else if (mod && key === 'd' && !typing && selected) {
      e.preventDefault();
      duplicate(selected);
    } else if (e.key === 'Escape' && !typing) {
      if (palette) closePalette();
      else closePanel();
    } else if (!typing && !mod && !e.altKey) {
      if (key === 'a' || e.key === '/') { e.preventDefault(); openPalette(selected ? { after: selected } : {}); }
      else if (e.key === '?') { e.preventDefault(); showShortcuts(); }
      else if (key === 'l') { e.preventDefault(); toggleView(); }
    }
  };
  document.addEventListener('keydown', onKey);
  const beforeUnload = (e) => {
    if (dirty || saving) {
      backup();
      e.preventDefault();
      void save();
    }
  };
  window.addEventListener('beforeunload', beforeUnload);

  /* ---------- first open ---------- */
  runChecks();
  const from = query?.get('from');
  if (from === 'plan' || from === 'template') {
    // Fresh drafts get a tidy layout based on how tall each card actually renders.
    setTimeout(() => {
      if (view === 'canvas' && hasOverlap(def, canvas.sizes())) {
        autoLayout(def, heights());
        canvas.setDefinition(def);
        setTimeout(() => canvas.fit(), 30);
        markDirty();
      }
    }, 60);
    const hint = h('div', { class: 'canvas-hint draft-hint', role: 'status', style: { top: '14px' } }, icon('info', 15),
      h('span', {}, 'This is a draft. Review each step, then press Test. Nothing is live until you deploy.'),
      button('Test it', { size: 'sm', kind: 'primary', onClick: () => { hint.remove(); openPanel('test'); } }),
      button('', { icon: 'close', size: 'sm', kind: 'ghost', title: 'Dismiss', onClick: () => hint.remove() }));
    canvasHost.append(hint);
    history.replaceState(null, '', `/flows/${encodeURIComponent(id)}`);
  }
  if (query?.get('panel') === 'test') setTimeout(() => openPanel('test'), 0);
  else if (query?.get('node') && def.nodes.some((n) => n.id === query.get('node'))) setTimeout(() => { selected = query.get('node'); canvas.centerOn(selected); openPanel('node'); }, 50);
  else if (!def.nodes.length) setTimeout(() => openPalette({ triggersOnly: true }), 50);

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    clearTimeout(retryTimer);
    tester?.stop();
    if (dirty) { backup(); void save(); }
  };
}
