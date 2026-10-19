import { CATEGORY, nodeIcon } from '../shared.js';
import { button, clear, h, icon } from '../ui.js';
import { branchOptions, edgeOption, isBranching, isTrigger, nodeName, NODE_W, typeOf } from './graph.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  return el;
};
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

/**
 * Renders a flow definition and turns pointer, touch and keyboard gestures into intents via `hooks`:
 * select(nodeId | null), open(nodeId), selectEdge(edgeId), beforeMove(), move(nodeId, pos), connect(source, target, branch),
 * canConnect(source, target, branch) → problem | null, addAfter(nodeId, branch?, at?), deleteNode(id), deleteEdge(id),
 * viewport(v), moveNote(index, pos), editNote(index).
 */
export class Canvas {
  constructor(host, { catalog, hooks }) {
    this.catalog = catalog;
    this.hooks = hooks;
    this.view = { x: 0, y: 0, zoom: 1 };
    this.selected = null;
    this.selectedEdge = null;
    this.statuses = new Map();
    this.errors = new Map();
    this.flags = new Map();
    this.def = { nodes: [], edges: [], notes: [] };
    this.el = h('div', { class: 'canvas', tabindex: '0', role: 'application', 'aria-roledescription': 'workflow canvas', 'aria-label': 'Workflow canvas. Tab to a step, Enter to configure it, arrow keys to move it. Press ? for all shortcuts.' });
    this.world = h('div', { class: 'canvas-world' });
    this.edgesSvg = svg('svg', { class: 'canvas-edges', width: 1, height: 1, 'aria-hidden': 'true' });
    this.world.append(this.edgesSvg);
    this.nodesLayer = h('div', { class: 'canvas-nodes', role: 'list', 'aria-label': 'Steps' });
    this.world.append(this.nodesLayer);
    this.el.append(this.world);
    this.zoomLabel = h('button', { type: 'button', class: 'zoom-level', title: 'Reset zoom to 100% (0)', onClick: () => this.zoomTo(1) }, '100%');
    this.tools = h('div', { class: 'canvas-tools', role: 'toolbar', 'aria-label': 'Zoom' },
      button('', { icon: 'zoomIn', kind: 'ghost', size: 'sm', title: 'Zoom in (+)', onClick: () => this.zoomBy(1.2) }),
      this.zoomLabel,
      button('', { icon: 'zoomOut', kind: 'ghost', size: 'sm', title: 'Zoom out (−)', onClick: () => this.zoomBy(1 / 1.2) }),
      button('', { icon: 'fit', kind: 'ghost', size: 'sm', title: 'Fit to screen (F)', onClick: () => this.fit(true) }));
    this.hint = h('div', { class: 'canvas-hint hidden', role: 'status' });
    this.el.append(this.tools, this.hint);
    host.append(this.el);
    this.pointers = new Map();
    this.bind();
  }

  setDefinition(def) {
    this.def = def;
    this.draw();
  }

  setView(v) {
    this.view = { ...v };
    this.applyView();
  }

  applyView() {
    this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    this.el.style.backgroundSize = `${20 * this.view.zoom}px ${20 * this.view.zoom}px`;
    this.el.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    this.zoomLabel.textContent = `${Math.round(this.view.zoom * 100)}%`;
  }

  animate() {
    this.el.classList.add('animating');
    clearTimeout(this.animTimer);
    this.animTimer = setTimeout(() => this.el.classList.remove('animating'), 320);
  }

  zoomBy(factor, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    this.zoomTo(this.view.zoom * factor, cx, cy);
  }

  zoomTo(target, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    const zoom = Math.min(Math.max(target, MIN_ZOOM), MAX_ZOOM);
    const k = zoom / this.view.zoom;
    this.view = { zoom, x: cx - (cx - this.view.x) * k, y: cy - (cy - this.view.y) * k };
    this.applyView();
    this.hooks.viewport?.(this.view);
  }

  fit(animated = false) {
    const boxes = [...this.nodesLayer.querySelectorAll('.node, .note-card')].map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: el.offsetWidth || NODE_W, h: el.offsetHeight || 80 }));
    if (animated) this.animate();
    if (!boxes.length) {
      this.view = { x: this.el.clientWidth / 2 - NODE_W / 2, y: 80, zoom: 1 };
      this.applyView();
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x)) - 60;
    const minY = Math.min(...boxes.map((b) => b.y)) - 60;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 60;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 90;
    const zoom = Math.min(Math.max(Math.min(this.el.clientWidth / (maxX - minX), this.el.clientHeight / (maxY - minY)), 0.25), 1.1);
    this.view = { zoom, x: (this.el.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom, y: (this.el.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom };
    this.applyView();
    this.hooks.viewport?.(this.view);
  }

  /** Scrolls a node into the middle of the view. */
  centerOn(id) {
    const node = this.def.nodes.find((n) => n.id === id);
    if (!node) return;
    this.animate();
    this.view = { ...this.view, x: this.el.clientWidth / 2 - (node.position.x + NODE_W / 2) * this.view.zoom, y: this.el.clientHeight / 3 - node.position.y * this.view.zoom };
    this.applyView();
    this.hooks.viewport?.(this.view);
  }

  /** Rendered card sizes, for layout that avoids overlaps. */
  sizes() {
    return new Map(this.nodeEls().map((el) => [el.dataset.id, { w: el.offsetWidth || NODE_W, h: el.offsetHeight || 100 }]));
  }

  focusNode(id) {
    this.nodeEls().find((el) => el.dataset.id === id)?.focus({ preventScroll: true });
  }

  toWorld(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  center() {
    const r = this.el.getBoundingClientRect();
    return this.toWorld(r.left + this.el.clientWidth / 2, r.top + this.el.clientHeight / 3);
  }

  nodeEls() {
    return [...this.nodesLayer.querySelectorAll('.node')];
  }

  select(id) {
    this.selected = id;
    this.selectedEdge = null;
    for (const el of this.nodeEls()) {
      el.classList.toggle('selected', el.dataset.id === id);
      el.setAttribute('aria-selected', el.dataset.id === id ? 'true' : 'false');
    }
    this.drawEdges();
  }

  setStatuses(map) {
    this.statuses = map;
    for (const el of this.nodeEls()) {
      const st = map.get(el.dataset.id);
      el.classList.remove('st-running', 'st-success', 'st-failed', 'st-skipped', 'st-cancelled');
      if (st) el.classList.add(`st-${st.status}`);
      const slot = el.querySelector('.node-status');
      if (slot) {
        clear(slot);
        if (st?.status === 'running') slot.append(h('span', { class: 'spinner', style: { width: '12px', height: '12px' } }), h('span', { class: 'sr-only' }, 'running'));
        else if (st?.status === 'success') slot.append(icon('check', 14), st.durationMs !== undefined ? `${Math.round(st.durationMs)} ms` : 'done');
        else if (st?.status === 'failed') slot.append(icon('alert', 14), 'failed');
        else if (st?.status === 'skipped') slot.append('skipped');
        else if (st?.status === 'cancelled') slot.append('stopped');
      }
    }
    this.drawEdges();
  }

  setErrors(map) {
    this.errors = map;
    this.paintFlags();
  }

  /** Setup needs (missing model, empty collection, credentials) shown on each step. Map of nodeId → text. */
  setFlags(map) {
    this.flags = map;
    this.paintFlags();
  }

  paintFlags() {
    for (const el of this.nodeEls()) {
      const id = el.dataset.id;
      const error = this.errors.get(id);
      const flag = this.flags.get(id);
      el.classList.toggle('has-error', !!error);
      el.classList.toggle('needs-setup', !error && !!flag);
      el.title = error ?? flag ?? '';
      el.querySelector('.node-flag')?.remove();
      if (error || flag) el.querySelector('.node-head')?.after(h('div', { class: ['node-flag', error ? 'error' : ''] }, icon('alert', 11), error ? 'Fix configuration' : 'Needs setup'));
    }
  }

  /* ---------- rendering ---------- */

  draw() {
    clear(this.nodesLayer);
    (this.def.notes ?? []).forEach((note, i) => this.nodesLayer.append(this.noteEl(note, i)));
    for (const node of this.def.nodes) this.nodesLayer.append(this.nodeEl(node));
    this.setStatuses(this.statuses);
    this.paintFlags();
    requestAnimationFrame(() => this.drawEdges());
  }

  redrawNode(id) {
    const node = this.def.nodes.find((n) => n.id === id);
    const old = this.nodeEls().find((el) => el.dataset.id === id);
    if (!node || !old) return this.draw();
    const focused = document.activeElement === old;
    const fresh = this.nodeEl(node);
    old.replaceWith(fresh);
    if (focused) fresh.focus({ preventScroll: true });
    this.setStatuses(this.statuses);
    this.paintFlags();
    requestAnimationFrame(() => this.drawEdges());
  }

  noteEl(note, index) {
    const el = h('div', { class: `note-card note-${note.color ?? 'yellow'}`, style: { left: `${note.x ?? 0}px`, top: `${note.y ?? 0}px`, width: `${note.width ?? 320}px` }, role: 'note', tabindex: '0', 'aria-label': `Note: ${note.title ?? ''}. Press Enter to edit.` },
      note.title ? h('h4', {}, note.title) : null, note.text ?? '');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY, nx: note.x ?? 0, ny: note.y ?? 0 };
      el.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        note.x = Math.round(start.nx + (ev.clientX - start.x) / this.view.zoom);
        note.y = Math.round(start.ny + (ev.clientY - start.y) / this.view.zoom);
        el.style.left = `${note.x}px`;
        el.style.top = `${note.y}px`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (note.x !== start.nx || note.y !== start.ny) this.hooks.moveNote?.(index, { x: note.x, y: note.y });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => this.hooks.editNote?.(index));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.hooks.editNote?.(index); });
    return el;
  }

  nodeEl(node) {
    const spec = this.catalog.byType.get(typeOf(node));
    const trigger = isTrigger(node, this.catalog);
    const branching = isBranching(node);
    const name = nodeName(node, this.catalog);
    const terminal = spec?.kind === 'response';
    const summary = spec?.summary ?? spec?.description ?? '';
    const preview = this.preview(node);
    const el = h('div', {
      class: ['node', this.selected === node.id ? 'selected' : ''], dataset: { id: node.id },
      style: { left: `${node.position.x}px`, top: `${node.position.y}px` },
      tabindex: '0', role: 'listitem', 'aria-selected': this.selected === node.id ? 'true' : 'false',
      'aria-label': `${name}, ${spec?.label ?? 'unknown step'}${trigger ? ', trigger' : ''}. ${summary}`,
    },
      trigger ? null : h('span', { class: 'handle handle-in', dataset: { handle: 'in' }, 'aria-hidden': 'true' }),
      trigger ? null : h('span', { class: 'port-label in', 'aria-hidden': 'true' }, 'input'),
      h('div', { class: 'node-head' },
        nodeIcon(spec ?? { category: 'app', icon: 'app' }),
        h('div', { class: 'grow' }, h('div', { class: 'node-title truncate' }, name), h('div', { class: 'node-type truncate' }, spec ? `${spec.label}${trigger ? ' · starts the workflow' : terminal ? ' · finishes' : ''}` : `Unknown step type ${typeOf(node)}`)),
        h('span', { class: 'node-status', 'aria-live': 'polite' })),
      preview ?? (summary ? h('div', { class: 'node-summary' }, summary) : null),
      branching ? h('div', { class: 'node-branches' }, branchOptions(node).map((o) => h('span', { class: 'branch-chip', dataset: { branch: o.value } }, o.label, h('span', { class: 'branch-handle', title: `Drag to connect “${o.label}”`, dataset: { branch: o.value } })))) : null,
      !branching && !terminal ? h('span', { class: 'handle handle-out', title: 'Drag to connect to the next step', dataset: { handle: 'out' }, 'aria-hidden': 'true' }) : null,
      !branching && !terminal ? h('span', { class: 'port-label out', 'aria-hidden': 'true' }, 'output') : null,
      !terminal && !branching ? h('button', { type: 'button', class: 'node-add', title: 'Add a step after this one', 'aria-label': `Add a step after ${name}`, dataset: { add: '1' } }, icon('plus', 12)) : null,
    );
    const accent = CATEGORY[spec?.category]?.color;
    if (accent) el.style.setProperty('--cat', accent);
    return el;
  }

  preview(node) {
    const v = node.data.values ?? {};
    const type = typeOf(node);
    const firstUser = Array.isArray(v.prompts) ? (v.prompts.find((p) => p.role === 'user') ?? v.prompts[0])?.content : undefined;
    let text = '';
    if (type === 'apiNode') text = `${v.method ?? 'GET'} ${v.url ?? ''}`;
    else if (type === 'RAGNode' || /search|Index|vector/i.test(type)) text = [Array.isArray(v.vectorDB) ? v.vectorDB[0] : v.vectorDB].filter(Boolean).map((c) => `knowledge: ${c}`).join('');
    else if (type === 'codeNode') text = String(v.code ?? '').split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ?? '';
    else if (type === 'cronNode') text = `${v.cronExpression ?? ''} ${v.cronTimezone ?? ''}`;
    else if (type === 'localFolderNode') text = v.folderPath || 'Choose a folder';
    else if (type === 'memoryNode' || type === 'memoryRetrieveNode') text = v.memoryCollection ? `memory: ${v.memoryCollection}` : '';
    else if (type === 'forLoopNode' || type === 'batchNode') text = v.iterateOver === 'range' ? `${v.initialValue ?? 0} → ${v.endValue ?? ''}` : String(v.iteratorValue ?? '');
    else if (type === 'flowNode') text = v.flowId ?? '';
    else if (type === 'rssNode' || type === 'scraperNode') text = v.url ?? '';
    else if (firstUser && type !== 'agentClassifierNode') text = firstUser;
    if (!text) return null;
    const spec = this.catalog.byType.get(type);
    return h('div', { class: 'node-body' }, spec?.summary ? h('div', { class: 'node-summary', style: { padding: 0 } }, spec.summary) : null, h('div', { class: 'node-preview', title: String(text) }, String(text).slice(0, 120)));
  }

  /** Bottom-centre of a node, or of one of its branch chips. */
  anchor(nodeId, branch, side) {
    const el = this.nodeEls().find((x) => x.dataset.id === nodeId);
    if (!el) return null;
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    const w = el.offsetWidth || NODE_W;
    const hgt = el.offsetHeight || 80;
    if (side === 'in') return { x: x + w / 2, y };
    if (branch !== undefined) {
      const chip = [...el.querySelectorAll('.branch-chip')].find((c) => c.dataset.branch === branch);
      if (chip) return { x: x + chip.offsetLeft + chip.offsetWidth / 2, y: y + chip.offsetTop + chip.offsetHeight };
    }
    return { x: x + w / 2, y: y + hgt };
  }

  drawEdges() {
    clear(this.edgesSvg);
    const nodes = new Map(this.def.nodes.map((n) => [n.id, n]));
    for (const edge of this.def.edges) {
      if (edge.data?.invisible) continue;
      const source = nodes.get(edge.source);
      if (!source || !nodes.has(edge.target)) continue;
      const option = isBranching(source) ? edgeOption(edge, source) : undefined;
      const from = this.anchor(edge.source, option?.value, 'out');
      const to = this.anchor(edge.target, undefined, 'in');
      if (!from || !to) continue;
      const kind = edge.type === 'responseEdge' ? 'response' : edge.type === 'loopEdge' || edge.type === 'agentLoopEdge' ? 'loop' : '';
      if (kind === 'response') continue;
      let d;
      if (kind === 'loop' || to.y < from.y - 20) {
        const side = Math.max(from.x, to.x) + NODE_W / 2 + 40;
        d = `M ${from.x} ${from.y} C ${from.x} ${from.y + 60}, ${side} ${from.y + 60}, ${side} ${(from.y + to.y) / 2} S ${to.x} ${to.y - 60}, ${to.x} ${to.y}`;
        if (kind === 'loop') {
          const right = from.x + NODE_W / 2 + 50;
          d = `M ${from.x + NODE_W / 2 - 10} ${from.y - 30} C ${right} ${from.y - 20}, ${right} ${to.y + 10}, ${to.x + NODE_W / 2 - 10} ${to.y + 20}`;
        }
      } else {
        const dy = Math.max(40, Math.abs(to.y - from.y) / 2);
        d = `M ${from.x} ${from.y} C ${from.x} ${from.y + dy}, ${to.x} ${to.y - dy}, ${to.x} ${to.y}`;
      }
      const status = this.statuses.get(edge.source);
      const targetStatus = this.statuses.get(edge.target);
      const active = status?.status === 'success' && targetStatus && targetStatus.status !== 'skipped' && targetStatus.status !== 'running';
      const running = status?.status === 'success' && targetStatus?.status === 'running';
      const path = svg('path', { d, class: ['edge-path', kind, this.selectedEdge === edge.id ? 'selected' : '', active ? 'active' : '', running ? 'running' : ''].join(' ') });
      const hit = svg('path', { d, class: 'edge-hit' });
      const pick = (e) => {
        e.stopPropagation();
        this.selectedEdge = edge.id;
        this.selected = null;
        for (const n of this.nodeEls()) n.classList.remove('selected');
        this.drawEdges();
        this.hooks.selectEdge?.(edge.id);
        this.el.focus({ preventScroll: true });
      };
      hit.addEventListener('pointerdown', pick);
      path.addEventListener('pointerdown', pick);
      this.edgesSvg.append(hit, path);
      if (option && kind !== 'loop') {
        const label = svg('text', { x: (from.x + to.x) / 2 + 6, y: (from.y + to.y) / 2, class: 'edge-label' });
        label.textContent = option.label;
        this.edgesSvg.append(label);
      }
    }
    if (this.draft) this.edgesSvg.append(svg('path', { d: `M ${this.draft.from.x} ${this.draft.from.y} C ${this.draft.from.x} ${this.draft.from.y + 60}, ${this.draft.to.x} ${this.draft.to.y - 60}, ${this.draft.to.x} ${this.draft.to.y}`, class: `edge-path draft${this.draft.invalid ? ' invalid' : ''}` }));
  }

  showHint(text, ms = 0) {
    this.hint.textContent = text;
    this.hint.classList.toggle('hidden', !text);
    clearTimeout(this.hintTimer);
    if (ms && text) this.hintTimer = setTimeout(() => this.hint.classList.add('hidden'), ms);
  }

  /* ---------- interaction ---------- */

  bind() {
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = this.el.getBoundingClientRect();
        this.zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else {
        this.view.x -= e.deltaX;
        this.view.y -= e.deltaY;
        this.applyView();
        this.hooks.viewport?.(this.view);
      }
    }, { passive: false });

    this.el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) return this.startPinch();
      if (e.button !== 0 || e.target.closest('.canvas-tools, .palette, .canvas-hint, .canvas-empty, .outline')) return;
      const nodeEl = e.target.closest('.node');
      const outHandle = e.target.closest('.handle-out, .branch-handle');
      if (e.target.closest('.node-add')) {
        e.stopPropagation();
        this.hooks.addAfter?.(nodeEl.dataset.id);
        return;
      }
      if (outHandle && nodeEl) return this.startConnect(e, nodeEl.dataset.id, outHandle.dataset.branch);
      if (nodeEl) return this.startDrag(e, nodeEl);
      this.startPan(e);
    });
    const release = (e) => this.pointers.delete(e.pointerId);
    this.el.addEventListener('pointerup', release);
    this.el.addEventListener('pointercancel', release);

    this.el.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, .palette, .outline')) return;
      const nodeEl = e.target.closest?.('.node');
      const id = nodeEl?.dataset.id ?? this.selected;
      if ((e.key === 'Enter' || e.key === ' ') && nodeEl) {
        e.preventDefault();
        this.select(nodeEl.dataset.id);
        this.hooks.open?.(nodeEl.dataset.id);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selectedEdge || id)) {
        e.preventDefault();
        if (this.selectedEdge) this.hooks.deleteEdge?.(this.selectedEdge);
        else this.hooks.deleteNode?.(id);
      } else if (e.key.startsWith('Arrow') && id && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const node = this.def.nodes.find((n) => n.id === id);
        if (!node) return;
        const step = e.shiftKey ? 50 : 10;
        this.hooks.beforeMove?.();
        node.position = { x: node.position.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), y: node.position.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) };
        const el = this.nodeEls().find((x) => x.dataset.id === id);
        if (el) { el.style.left = `${node.position.x}px`; el.style.top = `${node.position.y}px`; }
        this.drawEdges();
        this.hooks.move?.(id, node.position);
      } else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1.2); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(1 / 1.2); }
      else if (e.key === '0') { e.preventDefault(); this.zoomTo(1); }
      else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.fit(true); }
    });
    this.nodesLayer.addEventListener('focusin', (e) => {
      const nodeEl = e.target.closest?.('.node');
      if (nodeEl && this.selected !== nodeEl.dataset.id) {
        this.selected = nodeEl.dataset.id;
        for (const el of this.nodeEls()) el.classList.toggle('selected', el === nodeEl);
        this.drawEdges();
      }
    });
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    const startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const startZoom = this.view.zoom;
    const r = this.el.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - r.left;
    const cy = (a.y + b.y) / 2 - r.top;
    const move = (ev) => {
      if (!this.pointers.has(ev.pointerId)) return;
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pointers.size < 2) return;
      const [p, q] = [...this.pointers.values()];
      this.zoomTo(startZoom * (Math.hypot(p.x - q.x, p.y - q.y) / startDist), cx, cy);
    };
    const up = () => {
      if (this.pointers.size >= 2) return;
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  startPan(e) {
    const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
    let moved = false;
    this.el.classList.add('panning');
    this.el.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      if (this.pointers.size > 1) return;
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
      this.view.x = start.vx + ev.clientX - start.x;
      this.view.y = start.vy + ev.clientY - start.y;
      this.applyView();
    };
    const up = () => {
      this.el.classList.remove('panning');
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      if (moved) this.hooks.viewport?.(this.view);
      else {
        this.selected = null;
        this.selectedEdge = null;
        this.select(null);
        this.hooks.select?.(null);
      }
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
  }

  startDrag(e, nodeEl) {
    const id = nodeEl.dataset.id;
    const node = this.def.nodes.find((n) => n.id === id);
    const start = { x: e.clientX, y: e.clientY, nx: node.position.x, ny: node.position.y };
    let moved = false;
    nodeEl.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      if (this.pointers.size > 1) return;
      const dx = (ev.clientX - start.x) / this.view.zoom;
      const dy = (ev.clientY - start.y) / this.view.zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) this.hooks.beforeMove?.();
      moved = true;
      node.position = { x: Math.round((start.nx + dx) / 10) * 10, y: Math.round((start.ny + dy) / 10) * 10 };
      nodeEl.style.left = `${node.position.x}px`;
      nodeEl.style.top = `${node.position.y}px`;
      this.drawEdges();
    };
    const up = () => {
      nodeEl.removeEventListener('pointermove', move);
      nodeEl.removeEventListener('pointerup', up);
      if (moved) this.hooks.move?.(id, node.position);
      else {
        this.select(id);
        this.hooks.select?.(id);
      }
      nodeEl.focus({ preventScroll: true });
    };
    nodeEl.addEventListener('pointermove', move);
    nodeEl.addEventListener('pointerup', up);
  }

  startConnect(e, sourceId, branch) {
    e.stopPropagation();
    const from = this.anchor(sourceId, branch, 'out');
    this.draft = { from, to: from, invalid: false };
    this.el.setPointerCapture?.(e.pointerId);
    this.el.classList.add('connecting');
    // Show which steps can accept this connection before the user lets go.
    const problems = new Map(this.def.nodes.map((n) => [n.id, n.id === sourceId ? 'self' : this.hooks.canConnect?.(sourceId, n.id, branch) ?? null]));
    for (const el of this.nodeEls()) {
      const problem = problems.get(el.dataset.id);
      el.classList.toggle('can-drop', !problem);
      el.classList.toggle('dim', !!problem && problem !== 'self');
    }
    this.showHint('Release on a highlighted step to connect it, or on empty space to add a new step.');
    let hover = null;
    const move = (ev) => {
      this.draft.to = this.toWorld(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.node');
      if (hover && hover !== target) hover.classList.remove('drop-hover');
      hover = target && target.dataset.id !== sourceId ? target : null;
      hover?.classList.add('drop-hover');
      const problem = hover ? problems.get(hover.dataset.id) : null;
      this.draft.invalid = !!problem;
      if (hover) this.showHint(problem ?? `Release to connect to “${hover.querySelector('.node-title')?.textContent ?? ''}”.`);
      this.drawEdges();
    };
    const up = (ev) => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.classList.remove('connecting');
      hover?.classList.remove('drop-hover');
      for (const el of this.nodeEls()) el.classList.remove('can-drop', 'dim');
      this.draft = null;
      this.showHint('');
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.node');
      if (target && target.dataset.id !== sourceId) {
        const problem = problems.get(target.dataset.id);
        if (problem) this.showHint(problem, 3500);
        else this.hooks.connect?.(sourceId, target.dataset.id, branch);
      } else if (!target) this.hooks.addAfter?.(sourceId, branch, this.toWorld(ev.clientX, ev.clientY));
      this.drawEdges();
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
  }
}
