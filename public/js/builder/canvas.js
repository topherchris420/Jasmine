import { nodeIcon } from '../shared.js';
import { button, clear, h, icon } from '../ui.js';
import { branchOptions, edgeOption, isBranching, isTrigger, nodeName, NODE_W, typeOf } from './graph.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  return el;
};

/**
 * Renders a flow definition and turns pointer gestures into intents via `hooks`:
 * select(nodeId | null), selectEdge(edgeId), move(nodeId, pos, done), connect(source, target, branch), addAfter(nodeId, branch?),
 * viewport(v), moveNote(index, pos, done).
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
    this.def = { nodes: [], edges: [], notes: [] };
    this.el = h('div', { class: 'canvas', tabindex: '0', 'aria-label': 'Flow canvas' });
    this.world = h('div', { class: 'canvas-world' });
    this.edgesSvg = svg('svg', { class: 'canvas-edges', width: 1, height: 1 });
    this.world.append(this.edgesSvg);
    this.nodesLayer = h('div', { class: 'canvas-nodes' });
    this.world.append(this.nodesLayer);
    this.el.append(this.world);
    this.tools = h('div', { class: 'canvas-tools' },
      button('', { icon: 'zoomIn', kind: 'ghost', size: 'sm', title: 'Zoom in', onClick: () => this.zoomBy(1.2) }),
      button('', { icon: 'zoomOut', kind: 'ghost', size: 'sm', title: 'Zoom out', onClick: () => this.zoomBy(1 / 1.2) }),
      button('', { icon: 'fit', kind: 'ghost', size: 'sm', title: 'Fit to screen', onClick: () => this.fit() }));
    this.el.append(this.tools);
    host.append(this.el);
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
  }

  zoomBy(factor, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    const zoom = Math.min(Math.max(this.view.zoom * factor, 0.2), 2);
    const k = zoom / this.view.zoom;
    this.view = { zoom, x: cx - (cx - this.view.x) * k, y: cy - (cy - this.view.y) * k };
    this.applyView();
    this.hooks.viewport?.(this.view);
  }

  fit() {
    const boxes = [...this.nodesLayer.querySelectorAll('.node, .note-card')].map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: el.offsetWidth, h: el.offsetHeight }));
    if (!boxes.length) {
      this.view = { x: this.el.clientWidth / 2 - NODE_W / 2, y: 80, zoom: 1 };
      this.applyView();
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x)) - 60;
    const minY = Math.min(...boxes.map((b) => b.y)) - 60;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 60;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 80;
    const zoom = Math.min(Math.max(Math.min(this.el.clientWidth / (maxX - minX), this.el.clientHeight / (maxY - minY)), 0.25), 1.1);
    this.view = { zoom, x: (this.el.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom, y: (this.el.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom };
    this.applyView();
    this.hooks.viewport?.(this.view);
  }

  toWorld(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  center() {
    return this.toWorld(this.el.getBoundingClientRect().left + this.el.clientWidth / 2, this.el.getBoundingClientRect().top + this.el.clientHeight / 3);
  }

  select(id) {
    this.selected = id;
    this.selectedEdge = null;
    for (const el of this.nodesLayer.querySelectorAll('.node')) el.classList.toggle('selected', el.dataset.id === id);
    this.drawEdges();
  }

  setStatuses(map) {
    this.statuses = map;
    for (const el of this.nodesLayer.querySelectorAll('.node')) {
      const st = map.get(el.dataset.id);
      el.classList.remove('st-running', 'st-success', 'st-failed', 'st-skipped');
      if (st) el.classList.add(`st-${st.status}`);
      const slot = el.querySelector('.node-status');
      if (slot) {
        clear(slot);
        if (st?.status === 'running') slot.append(h('span', { class: 'spinner', style: { width: '12px', height: '12px' } }));
        else if (st?.status === 'success') slot.append(icon('check', 14), st.durationMs !== undefined ? `${Math.round(st.durationMs)} ms` : '');
        else if (st?.status === 'failed') slot.append(icon('alert', 14));
        else if (st?.status === 'skipped') slot.append('skipped');
      }
    }
    this.drawEdges();
  }

  setErrors(map) {
    this.errors = map;
    for (const el of this.nodesLayer.querySelectorAll('.node')) {
      el.classList.toggle('has-error', map.has(el.dataset.id));
      el.title = map.get(el.dataset.id) ?? '';
    }
  }

  /* ---------- rendering ---------- */

  draw() {
    clear(this.nodesLayer);
    (this.def.notes ?? []).forEach((note, i) => this.nodesLayer.append(this.noteEl(note, i)));
    for (const node of this.def.nodes) this.nodesLayer.append(this.nodeEl(node));
    this.setStatuses(this.statuses);
    this.setErrors(this.errors);
    requestAnimationFrame(() => this.drawEdges());
  }

  redrawNode(id) {
    const node = this.def.nodes.find((n) => n.id === id);
    const old = this.nodesLayer.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
    if (!node || !old) return this.draw();
    old.replaceWith(this.nodeEl(node));
    this.setStatuses(this.statuses);
    this.setErrors(this.errors);
    requestAnimationFrame(() => this.drawEdges());
  }

  noteEl(note, index) {
    const el = h('div', { class: `note-card note-${note.color ?? 'yellow'}`, style: { left: `${note.x ?? 0}px`, top: `${note.y ?? 0}px`, width: `${note.width ?? 320}px` } },
      note.title ? h('h4', {}, note.title) : null, note.text ?? '');
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY, nx: note.x ?? 0, ny: note.y ?? 0 };
      el.setPointerCapture(e.pointerId);
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
    return el;
  }

  nodeEl(node) {
    const spec = this.catalog.byType.get(typeOf(node));
    const trigger = isTrigger(node, this.catalog);
    const branching = isBranching(node);
    const el = h('div', { class: ['node', this.selected === node.id ? 'selected' : ''], dataset: { id: node.id }, style: { left: `${node.position.x}px`, top: `${node.position.y}px` }, tabindex: '0', role: 'button', 'aria-label': nodeName(node, this.catalog) },
      trigger ? null : h('span', { class: 'handle handle-in', dataset: { handle: 'in' } }),
      h('div', { class: 'node-head' },
        nodeIcon(spec ?? { category: 'app', icon: 'app' }),
        h('div', { class: 'grow' }, h('div', { class: 'node-title truncate' }, nodeName(node, this.catalog)), h('div', { class: 'node-type truncate' }, spec ? `${nodeName(node, this.catalog) === spec.label ? node.id : spec.label}${trigger ? ' · trigger' : ''}` : `Unknown type ${typeOf(node)}`)),
        h('span', { class: 'node-status' })),
      this.preview(node),
      branching ? h('div', { class: 'node-branches' }, branchOptions(node).map((o) => h('span', { class: 'branch-chip', dataset: { branch: o.value } }, o.label, h('span', { class: 'branch-handle', title: `Connect “${o.label}”`, dataset: { branch: o.value } })))) : null,
      !branching && spec?.kind !== 'response' ? h('span', { class: 'handle handle-out', title: 'Drag to connect', dataset: { handle: 'out' } }) : null,
      spec?.kind !== 'response' && !branching ? h('button', { type: 'button', class: 'node-add', title: 'Add a node after this one', 'aria-label': 'Add node after', dataset: { add: '1' } }, icon('plus', 12)) : null,
    );
    return el;
  }

  preview(node) {
    const v = node.data.values ?? {};
    const type = typeOf(node);
    const firstUser = Array.isArray(v.prompts) ? (v.prompts.find((p) => p.role === 'user') ?? v.prompts[0])?.content : undefined;
    let text = '';
    if (type === 'apiNode') text = `${v.method ?? 'GET'} ${v.url ?? ''}`;
    else if (type === 'RAGNode' || /search|Index|vector/i.test(type)) text = [Array.isArray(v.vectorDB) ? v.vectorDB[0] : v.vectorDB, v.queryField ?? v.searchQuery ?? ''].filter(Boolean).join(' · ');
    else if (type === 'codeNode') text = String(v.code ?? '').split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ?? '';
    else if (firstUser) text = firstUser;
    else if (type === 'graphqlResponseNode') text = (typeof v.outputMapping === 'object' ? JSON.stringify(v.outputMapping) : String(v.outputMapping ?? '')).replace(/\s+/g, ' ');
    else if (type === 'chatResponseNode') text = String(v.content ?? '');
    else if (type === 'cronNode') text = `${v.cronExpression ?? ''} ${v.cronTimezone ?? ''}`;
    else if (type === 'localFolderNode') text = v.folderPath || 'Choose a folder';
    else if (type === 'memoryNode' || type === 'memoryRetrieveNode') text = v.memoryCollection ?? '';
    else if (type === 'forLoopNode' || type === 'batchNode') text = v.iterateOver === 'range' ? `${v.initialValue ?? 0} → ${v.endValue ?? ''}` : String(v.iteratorValue ?? '');
    else if (type === 'flowNode') text = v.flowId ?? '';
    else if (v.url) text = String(v.url);
    if (!text) return null;
    return h('div', { class: 'node-body' }, h('div', { class: 'node-preview' }, String(text).slice(0, 120)));
  }

  /** Bottom-centre of a node, or of one of its branch chips. */
  anchor(nodeId, branch, side) {
    const el = this.nodesLayer.querySelector(`.node[data-id="${CSS.escape(nodeId)}"]`);
    if (!el) return null;
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    if (side === 'in') return { x: x + el.offsetWidth / 2, y };
    if (branch !== undefined) {
      const chip = el.querySelector(`.branch-chip[data-branch="${CSS.escape(branch)}"]`);
      if (chip) return { x: x + chip.offsetLeft + chip.offsetWidth / 2, y: y + chip.offsetTop + chip.offsetHeight };
    }
    return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight };
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
      if (kind === 'response') continue;
      const status = this.statuses.get(edge.source);
      const targetStatus = this.statuses.get(edge.target);
      const active = status?.status === 'success' && targetStatus && targetStatus.status !== 'skipped';
      const path = svg('path', { d, class: ['edge-path', kind, this.selectedEdge === edge.id ? 'selected' : '', active ? 'active' : ''].join(' ') });
      const hit = svg('path', { d, class: 'edge-hit' });
      const pick = (e) => {
        e.stopPropagation();
        this.selectedEdge = edge.id;
        this.selected = null;
        for (const n of this.nodesLayer.querySelectorAll('.node.selected')) n.classList.remove('selected');
        this.drawEdges();
        this.hooks.selectEdge?.(edge.id);
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
    if (this.draft) this.edgesSvg.append(svg('path', { d: `M ${this.draft.from.x} ${this.draft.from.y} C ${this.draft.from.x} ${this.draft.from.y + 60}, ${this.draft.to.x} ${this.draft.to.y - 60}, ${this.draft.to.x} ${this.draft.to.y}`, class: 'edge-path draft' }));
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
      if (e.button !== 0 || e.target.closest('.canvas-tools, .palette, .canvas-hint button, .canvas-empty button')) return;
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

    this.el.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selected || this.selectedEdge)) {
        e.preventDefault();
        if (this.selectedEdge) this.hooks.deleteEdge?.(this.selectedEdge);
        else this.hooks.deleteNode?.(this.selected);
      }
    });
  }

  startPan(e) {
    const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
    let moved = false;
    this.el.classList.add('panning');
    this.el.setPointerCapture(e.pointerId);
    const move = (ev) => {
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
    nodeEl.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / this.view.zoom;
      const dy = (ev.clientY - start.y) / this.view.zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
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
      this.el.focus({ preventScroll: true });
    };
    nodeEl.addEventListener('pointermove', move);
    nodeEl.addEventListener('pointerup', up);
  }

  startConnect(e, sourceId, branch) {
    e.stopPropagation();
    const from = this.anchor(sourceId, branch, 'out');
    this.draft = { from, to: from };
    this.el.setPointerCapture(e.pointerId);
    let hover = null;
    const move = (ev) => {
      this.draft.to = this.toWorld(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
      if (hover && hover !== target) hover.querySelector('.handle-in')?.classList.remove('drop-target');
      hover = target && target.dataset.id !== sourceId ? target : null;
      hover?.querySelector('.handle-in')?.classList.add('drop-target');
      this.drawEdges();
    };
    const up = (ev) => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      hover?.querySelector('.handle-in')?.classList.remove('drop-target');
      this.draft = null;
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
      if (target && target.dataset.id !== sourceId) this.hooks.connect?.(sourceId, target.dataset.id, branch);
      else if (!target) this.hooks.addAfter?.(sourceId, branch, this.toWorld(ev.clientX, ev.clientY));
      this.drawEdges();
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
  }
}
