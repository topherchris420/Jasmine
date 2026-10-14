import { api, catalog as loadCatalog } from '../api.js';
import { Canvas } from '../builder/canvas.js';
import { createLookups, renderConfig } from '../builder/config.js';
import { addNode, autoLayout, connect, duplicateNode, normalize, removeEdge, removeNode, triggerOf, typeOf } from '../builder/graph.js';
import { createTester } from '../builder/test.js';
import { CATEGORY, nodeIcon } from '../shared.js';
import { badge, button, clear, confirmDialog, debounce, downloadFile, emptyState, fill, h, icon, modal, pretty, timeAgo, toast } from '../ui.js';

export async function render(container, { id }, { navigate }) {
  const [catalog, flow] = await Promise.all([loadCatalog(), api.get(`/api/flows/${encodeURIComponent(id)}`)]);
  const lookups = createLookups();
  let def = normalize(flow.definition, catalog);
  let revision = flow.revision;
  let name = flow.name;
  let summary = flow.summary;
  let dirty = false;
  let saving = null;
  let conflict = false;
  const undo = [];
  const redo = [];
  let selected = null;
  let panel = null;
  let diagnostics = [];
  let nodeOutputs = new Map();
  let configTab = 'config';

  /* ---------- layout ---------- */
  const saveState = h('span', { class: 'save-state' }, 'Saved');
  const deployBadge = h('span');
  const nameInput = h('input', { class: 'builder-name', value: name, 'aria-label': 'Flow name', onInput: (e) => { name = e.target.value; document.title = `${name} · Jasmine`; markDirty(false); } });
  const bar = h('div', { class: 'builder-bar' },
    button('', { icon: 'chevronLeft', kind: 'ghost', title: 'Back to flows', onClick: () => navigate('/flows') }),
    nameInput, deployBadge, saveState, h('span', { class: 'grow' }),
    button('', { icon: 'undo', kind: 'ghost', title: 'Undo (Ctrl+Z)', onClick: () => doUndo() }),
    button('', { icon: 'redo', kind: 'ghost', title: 'Redo (Ctrl+Shift+Z)', onClick: () => doRedo() }),
    button('', { icon: 'layout', kind: 'ghost', title: 'Tidy layout', onClick: () => { checkpoint(); autoLayout(def); canvas.setDefinition(def); setTimeout(() => canvas.fit(), 30); markDirty(); } }),
    button('Add node', { icon: 'plus', onClick: () => openPalette() }),
    button('Validate', { icon: 'check', onClick: () => validate(true) }),
    button('Test', { icon: 'play', onClick: () => openPanel('test') }),
    button('', { icon: 'history', kind: 'ghost', title: 'Versions & export', onClick: () => openVersions() }),
    button('Deploy', { icon: 'deploy', kind: 'primary', onClick: () => deploy() }));
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
      selectEdge: () => {},
      move: () => markDirty(),
      moveNote: () => markDirty(),
      editNote: (i) => editNote(i),
      connect: (source, target, branch) => {
        checkpoint();
        if (connect(def, catalog, source, target, branch)) {
          canvas.setDefinition(def);
          markDirty();
        }
      },
      addAfter: (nodeId, branch, at) => openPalette({ after: nodeId, branch, at }),
      deleteNode: (nodeId) => deleteNode(nodeId),
      deleteEdge: (edgeId) => {
        checkpoint();
        removeEdge(def, edgeId);
        canvas.setDefinition(def);
        markDirty();
      },
      viewport: (v) => {
        def.viewport = { x: v.x, y: v.y, zoom: v.zoom };
      },
    },
  });
  canvas.setDefinition(def);
  if (def.viewport && Number.isFinite(def.viewport.zoom)) canvas.setView(def.viewport);
  else setTimeout(() => canvas.fit(), 30);

  const emptyHint = h('div', { class: 'canvas-empty' }, emptyState('flows', 'Start with a trigger', 'Every flow begins with a trigger: an API request, chat widget, webhook, schedule or folder. Then add AI, RAG and app nodes.', button('Add a trigger', { kind: 'primary', icon: 'plus', onClick: () => openPalette({ triggersOnly: true }) })));
  const refreshEmpty = () => {
    emptyHint.remove();
    if (!def.nodes.length) canvasHost.append(emptyHint);
  };
  refreshEmpty();

  /* ---------- saving ---------- */
  const updateBadges = () => {
    fill(deployBadge, summary?.deployedVersion
      ? badge(summary.draftChanged || dirty ? 'Deployed · changes pending' : 'Deployed', summary.draftChanged || dirty ? 'warning' : 'success')
      : badge('Draft', 'neutral'));
  };
  updateBadges();

  const save = async () => {
    if (conflict) return;
    if (saving) await saving;
    if (!dirty) return;
    dirty = false;
    saveState.textContent = 'Saving…';
    const snapshot = structuredClone(def);
    saving = api.put(`/api/flows/${encodeURIComponent(id)}`, { name: name.trim() || 'Untitled flow', definition: snapshot, expectedRevision: revision }).then((saved) => {
      revision = saved.revision;
      summary = saved.summary;
      saveState.textContent = `Saved ${timeAgo(saved.updatedAt)}`;
      updateBadges();
    }).catch((e) => {
      if (e.status === 409) {
        conflict = true;
        saveState.textContent = 'Changed elsewhere';
        toast('This flow was changed in another tab. Reload to continue editing.', 'error', 10000);
      } else {
        dirty = true;
        saveState.textContent = 'Not saved';
        toast(`Save failed: ${e.message}`, 'error');
      }
    }).finally(() => {
      saving = null;
    });
    await saving;
  };
  const scheduleSave = debounce(() => void save(), 700);
  function markDirty(redraw = false) {
    dirty = true;
    saveState.textContent = 'Unsaved changes';
    updateBadges();
    if (redraw) canvas.setDefinition(def);
    refreshEmpty();
    scheduleSave();
  }
  function checkpoint() {
    undo.push(JSON.stringify(def));
    if (undo.length > 100) undo.shift();
    redo.length = 0;
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
    if (selected && !def.nodes.some((n) => n.id === selected)) closePanel();
    else if (panel === 'node') openPanel('node');
    markDirty();
  }

  /* ---------- panels ---------- */
  let tester = null;
  function closePanel() {
    panel = null;
    selected = null;
    canvas.select(null);
    side.classList.add('hidden');
    clear(side);
  }
  const onNodeChange = debounce(() => canvas.redrawNode(selected), 250);
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
        lastRun: (nodeId) => nodeOutputs.get(nodeId),
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
        onDuplicate: () => {
          checkpoint();
          const copy = duplicateNode(def, node.id);
          if (copy) {
            canvas.setDefinition(def);
            selected = copy.id;
            openPanel('node');
            markDirty();
          }
        },
        onClose: () => closePanel(),
      });
    } else if (kind === 'test') {
      tester ??= createTester({
        flowId: id, catalog, getDefinition: () => def,
        beforeRun: () => save(),
        onStatuses: (map) => canvas.setStatuses(map),
        onNodeOutputs: (map) => (nodeOutputs = map),
        onSelectNode: (nodeId) => { selected = nodeId; configTab = 'output'; openPanel('node'); },
      });
      tester.refresh();
      fill(side, h('div', { class: 'panel-head' }, icon('play'), h('strong', { class: 'grow' }, 'Test'), h('span', { class: 'muted small' }, 'Runs the current draft'), button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Close', onClick: () => closePanel() })), tester.el);
    } else if (kind === 'issues') {
      fill(side, h('div', { class: 'panel-head' }, icon('alert'), h('strong', { class: 'grow' }, 'Validation'), button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Close', onClick: () => closePanel() })),
        h('div', { class: 'panel-body' }, diagnostics.length
          ? diagnostics.map((d) => h('div', { class: `diag diag-${d.severity}`, onClick: () => { if (d.nodeId && def.nodes.some((n) => n.id === d.nodeId)) { selected = d.nodeId; openPanel('node'); } } }, icon(d.severity === 'error' ? 'alert' : 'info', 14), h('div', {}, h('strong', {}, d.code), h('div', {}, d.message), d.nodeId ? h('div', { class: 'small' }, d.nodeId) : null)))
          : h('div', { class: 'callout callout-success' }, icon('check'), 'No problems found. This flow is ready to deploy.')));
    }
  }

  function deleteNode(nodeId) {
    checkpoint();
    removeNode(def, nodeId);
    canvas.setDefinition(def);
    if (selected === nodeId) closePanel();
    markDirty();
  }

  /* ---------- palette ---------- */
  let palette = null;
  function openPalette({ after, branch, at, triggersOnly } = {}) {
    palette?.remove();
    const hasTrigger = !!triggerOf(def, catalog);
    const items = catalog.list.filter((n) => !n.hidden && (triggersOnly ? n.kind === 'trigger' : !(n.kind === 'trigger' && hasTrigger)) && !(after && n.kind === 'trigger'));
    const search = h('input', { class: 'input', placeholder: 'Search nodes…', 'aria-label': 'Search nodes' });
    const list = h('div', { class: 'palette-list' });
    const order = ['trigger', 'ai', 'rag', 'data', 'logic', 'app', 'response'];
    const draw = () => {
      const q = search.value.toLowerCase();
      clear(list);
      for (const cat of order) {
        const group = items.filter((n) => n.category === cat && `${n.label} ${n.description} ${n.type}`.toLowerCase().includes(q));
        if (!group.length) continue;
        list.append(h('div', { class: 'palette-group' }, CATEGORY[cat]?.label ?? cat));
        for (const n of group) list.append(h('button', { type: 'button', class: 'palette-item', onClick: () => place(n.type) }, nodeIcon(n, 28), h('span', {}, h('strong', {}, n.label), h('small', {}, n.description))));
      }
      if (!list.childElementCount) list.append(h('p', { class: 'muted', style: { padding: '12px' } }, 'No matching nodes.'));
    };
    const place = (type) => {
      checkpoint();
      const source = after ? def.nodes.find((n) => n.id === after) : null;
      const position = at ?? (source ? { x: source.position.x, y: source.position.y + 170 } : canvas.center());
      const added = addNode(def, catalog, type, { x: Math.round(position.x / 10) * 10, y: Math.round(position.y / 10) * 10 }, after ? { after, branch } : {});
      canvas.setDefinition(def);
      palette.remove();
      palette = null;
      selected = added[0].id;
      openPanel('node');
      markDirty();
    };
    search.addEventListener('input', draw);
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { palette.remove(); palette = null; } });
    palette = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Add node' },
      h('div', { class: 'palette-search row' }, search, button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Close', onClick: () => { palette.remove(); palette = null; } })),
      after ? h('div', { class: 'muted small', style: { padding: '8px 14px 0' } }, `Connects after ${def.nodes.find((n) => n.id === after)?.data.values?.nodeName ?? after}${branch ? ` (${branch})` : ''}`) : null,
      list);
    canvasHost.append(palette);
    draw();
    search.focus();
  }

  function editNote(index) {
    const note = def.notes[index];
    const title = h('input', { class: 'input', value: note.title ?? '' });
    const text = h('textarea', { class: 'input', rows: 6 });
    text.value = note.text ?? '';
    modal({
      title: 'Edit note', body: h('div', { class: 'stack' }, title, text),
      actions: [
        { label: 'Delete note', kind: 'ghost', icon: 'trash', onClick: (close) => { checkpoint(); def.notes.splice(index, 1); canvas.setDefinition(def); markDirty(); close(); } },
        { label: 'Save', kind: 'primary', onClick: (close) => { checkpoint(); note.title = title.value; note.text = text.value; canvas.setDefinition(def); markDirty(); close(); } },
      ],
    });
  }

  /* ---------- validate & deploy ---------- */
  async function validate(show) {
    await save();
    const res = await api.post(`/api/flows/${encodeURIComponent(id)}/validate`, { definition: def });
    diagnostics = res.diagnostics ?? [];
    canvas.setErrors(new Map(diagnostics.filter((d) => d.severity === 'error' && d.nodeId).map((d) => [d.nodeId, d.message])));
    if (show) openPanel('issues');
    return res.ok;
  }

  async function deploy() {
    await save();
    if (!await validate(false)) {
      openPanel('issues');
      toast('Fix the errors before deploying', 'error');
      return;
    }
    try {
      const result = await api.post(`/api/flows/${encodeURIComponent(id)}/deploy`, {});
      summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`)).summary;
      updateBadges();
      toast(result.changed ? `Deployed ${result.version}` : 'Already deployed; nothing changed', 'success');
      const trigger = triggerOf(def, catalog);
      modal({
        title: 'Deployed', body: h('div', { class: 'stack' },
          h('p', {}, `Version ${result.version} is live. Runs started earlier keep the version they started on.`),
          trigger ? h('p', { class: 'muted' }, `Trigger: ${catalog.byType.get(typeOf(trigger))?.label ?? typeOf(trigger)}`) : null),
        actions: [{ label: 'Close', onClick: (close) => close() }, { label: 'Endpoints & embed code', kind: 'primary', icon: 'deploy', onClick: (close) => { close(); navigate(`/deployments/${id}`); } }],
      });
    } catch (e) {
      diagnostics = e.diagnostics ?? [{ severity: 'error', code: e.code ?? 'DEPLOY', message: e.message }];
      openPanel('issues');
      toast(e.message, 'error');
    }
  }

  async function openVersions() {
    const data = await api.get(`/api/flows/${encodeURIComponent(id)}/versions`);
    const body = h('div', { class: 'stack' },
      h('div', { class: 'row' },
        button('Export JSON', { icon: 'download', onClick: () => downloadFile(`${id}.json`, pretty({ meta: { name }, ...def })) }),
        button('Add sticky note', { icon: 'note', onClick: () => { checkpoint(); const c = canvas.center(); def.notes.push({ title: 'Note', text: 'Double-click to edit', color: 'yellow', x: Math.round(c.x), y: Math.round(c.y), width: 300 }); canvas.setDefinition(def); markDirty(); } }),
        summary?.deployedVersion ? button('Undeploy', { icon: 'stop2', kind: 'ghost', onClick: async () => {
          if (!await confirmDialog('Stop serving this flow? Its API, webhook, widget and schedule stop working until you deploy again.', { danger: true, confirmLabel: 'Undeploy' })) return;
          await api.post(`/api/flows/${encodeURIComponent(id)}/undeploy`);
          summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`)).summary;
          updateBadges();
          toast('Flow undeployed', 'success');
        } }) : null),
      data.versions.length ? h('div', { class: 'stack-sm' }, data.versions.map((v) => h('div', { class: 'row list-item', style: { flexDirection: 'row' } },
        h('code', {}, v.version), v.active ? badge('Active', 'success') : null, h('span', { class: 'muted small grow' }, timeAgo(v.deployedAt)),
        v.active ? null : button('Roll back', { size: 'sm', onClick: async (e) => {
          await api.post(`/api/flows/${encodeURIComponent(id)}/rollback`, { toVersion: v.version });
          toast(`Rolled back to ${v.version}`, 'success');
          e.target.closest('dialog')?.close();
          summary = (await api.get(`/api/flows/${encodeURIComponent(id)}`)).summary;
          updateBadges();
        } }),
        button('Restore into draft', { size: 'sm', kind: 'ghost', onClick: async (e) => {
          const version = await api.get(`/api/flows/${encodeURIComponent(id)}/versions/${v.version}`);
          checkpoint();
          def = normalize(version.definition, catalog);
          canvas.setDefinition(def);
          markDirty();
          e.target.closest('dialog')?.close();
          setTimeout(() => canvas.fit(), 30);
          toast('Version restored into the draft; deploy to make it live', 'info');
        } })))) : h('p', { class: 'muted' }, 'Not deployed yet. Each deploy creates an immutable version you can roll back to.'));
    modal({ title: 'Versions', body, wide: true });
  }

  /* ---------- keyboard ---------- */
  const onKey = (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    } else if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      doRedo();
    } else if (e.key === 'Escape' && !typing) {
      if (palette) {
        palette.remove();
        palette = null;
      } else closePanel();
    }
  };
  document.addEventListener('keydown', onKey);
  const beforeUnload = (e) => {
    if (dirty || saving) {
      e.preventDefault();
      void save();
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  if (!def.nodes.length) setTimeout(() => openPalette({ triggersOnly: true }), 50);

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    tester?.stop();
    if (dirty) void save();
  };
}
