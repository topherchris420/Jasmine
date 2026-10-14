/* Small SVG charts for Reports: stacked columns and a line, each with hover tooltips, a legend and a table view. */
import { h } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  return el;
};

export const compact = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+n.toFixed(n % 1 ? 1 : 0)}`;
};

/** A clean axis: step of 1, 2 or 5 × 10^n with about four intervals; integer data never gets fractional ticks. */
function niceScale(v, integer) {
  const raw = Math.max(v, integer ? 1 : Number.EPSILON) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = Math.max(1, Math.ceil(v / step));
  return { max: step * ticks, ticks };
}

/** Shared frame: measures its width, redraws on resize, owns tooltip, legend and table toggle. */
function frame({ title, legend, rows, columns, draw, height = 220 }) {
  const tip = h('div', { class: 'viz-tip', role: 'status', hidden: true });
  const plot = h('div', { class: 'viz-plot' }, tip);
  const tableBox = h('div', { class: 'viz-table', hidden: true });
  let showTable = false;
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => {
    showTable = !showTable;
    plot.hidden = showTable;
    tableBox.hidden = !showTable;
    toggle.textContent = showTable ? 'Show chart' : 'Show table';
    if (showTable && !tableBox.firstChild) {
      tableBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render(r)))))))));
    }
  } }, 'Show table');
  const root = h('div', { class: 'viz' },
    h('div', { class: 'viz-head' }, h('h3', {}, title), legend?.length > 1 ? h('div', { class: 'legend' }, legend.map((l) => h('span', {}, h('i', { style: { background: l.color } }), l.label))) : null, h('span', { class: 'grow' }), toggle),
    plot, tableBox);
  let lastWidth = 0;
  const render = () => {
    const width = plot.clientWidth;
    if (!width || width === lastWidth) return;
    lastWidth = width;
    plot.querySelector('svg')?.remove();
    const svg = svgEl('svg', { class: 'chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });
    draw(svg, width, height, tip);
    plot.prepend(svg);
  };
  const ro = new ResizeObserver(() => render());
  ro.observe(plot);
  return root;
}

function showTip(tip, plot, x, y, heading, lines) {
  tip.replaceChildren(h('div', { class: 'viz-tip-head' }, heading), ...lines.map((l) => h('div', { class: 'viz-tip-row' }, h('i', { style: { background: l.color } }), h('strong', {}, l.value), h('span', {}, l.label))));
  tip.hidden = false;
  const pw = plot.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(Math.max(0, x + 12), pw - tw)}px`;
  tip.style.top = `${Math.max(0, y - 10)}px`;
}

function axes(svg, { width, height, pad, max, ticks, labels, format = compact }) {
  const g = svgEl('g');
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = height - pad.bottom - ((height - pad.top - pad.bottom) * i) / ticks;
    g.append(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: i === 0 ? 'base-line' : 'grid-line' }));
    const t = svgEl('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end' });
    t.textContent = v === 0 ? '0' : format(v);
    g.append(t);
  }
  for (const l of labels) {
    const t = svgEl('text', { x: l.x, y: height - pad.bottom + 16, 'text-anchor': 'middle' });
    t.textContent = l.text;
    g.append(t);
  }
  svg.append(g);
}

/** Thins x labels so they never collide. */
function xLabels(points, width, labelFor) {
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(width / 70))));
  return points.flatMap((p, i) => (i % every === 0 ? [{ x: p.x, text: labelFor(p.d) }] : []));
}

/**
 * Stacked columns. series: [{ key, label, color }], data: [{ t, ...values }].
 * Bars are capped at 24px with a 4px rounded top and a 2px surface gap between segments.
 */
export function columnChart({ title, series, data, labelFor, tipFor, format = compact }) {
  return frame({
    title, legend: series,
    rows: data, columns: [{ label: 'Period', render: (d) => tipFor(d) }, ...series.map((s) => ({ label: s.label, num: true, render: (d) => format(d[s.key] ?? 0) }))],
    draw: (svg, width, height, tip) => {
      const pad = { top: 12, right: 8, bottom: 24, left: 40 };
      const totals = data.map((d) => series.reduce((a, s) => a + (d[s.key] ?? 0), 0));
      const { max, ticks } = niceScale(Math.max(1, ...totals), totals.every(Number.isInteger));
      const band = (width - pad.left - pad.right) / Math.max(1, data.length);
      const bw = Math.max(2, Math.min(24, band * 0.7));
      const yScale = (v) => ((height - pad.top - pad.bottom) * v) / max;
      const points = data.map((d, i) => ({ d, x: pad.left + band * i + band / 2 }));
      axes(svg, { width, height, pad, max, ticks, labels: xLabels(points, width, labelFor), format });
      const base = height - pad.bottom;
      for (const p of points) {
        const g = svgEl('g', { class: 'viz-mark', tabindex: 0 });
        let y = base;
        const segs = series.map((s) => ({ s, v: p.d[s.key] ?? 0 })).filter((x) => x.v > 0);
        segs.forEach(({ s, v }, i) => {
          const hgt = yScale(v);
          const top = i === segs.length - 1;
          const gap = i > 0 ? 2 : 0;
          const y0 = y - gap;
          const y1 = Math.min(y0, y - hgt);
          const r = top ? Math.min(4, bw / 2, y0 - y1) : 0;
          const x0 = p.x - bw / 2;
          const x1 = p.x + bw / 2;
          const d = `M${x0},${y0} V${y1 + r} Q${x0},${y1} ${x0 + r},${y1} H${x1 - r} Q${x1},${y1} ${x1},${y1 + r} V${y0} Z`;
          g.append(svgEl('path', { d, fill: s.color }));
          y = y1;
        });
        // Hit target: the full column band, not just the painted pixels.
        g.append(svgEl('rect', { x: p.x - band / 2, y: pad.top, width: band, height: base - pad.top, fill: 'transparent' }));
        const show = () => showTip(tip, svg.parentElement, p.x, Math.max(pad.top, y - 40), tipFor(p.d), series.map((s) => ({ color: s.color, label: s.label, value: format(p.d[s.key] ?? 0) })));
        g.addEventListener('pointerenter', show);
        g.addEventListener('focus', show);
        g.addEventListener('pointerleave', () => { tip.hidden = true; });
        g.addEventListener('blur', () => { tip.hidden = true; });
        svg.append(g);
      }
    },
  });
}

/** Single-series line with a crosshair that snaps to the nearest point. Null values break the line. */
export function lineChart({ title, label, color, data, valueKey, labelFor, tipFor, format = compact }) {
  return frame({
    title, legend: [{ label, color }],
    rows: data, columns: [{ label: 'Period', render: (d) => tipFor(d) }, { label, num: true, render: (d) => (d[valueKey] === null || d[valueKey] === undefined ? '—' : format(d[valueKey])) }],
    draw: (svg, width, height, tip) => {
      const pad = { top: 12, right: 12, bottom: 24, left: 48 };
      const values = data.map((d) => d[valueKey]).filter((v) => v !== null && v !== undefined);
      const { max, ticks } = niceScale(Math.max(1, ...values), false);
      const step = (width - pad.left - pad.right) / Math.max(1, data.length - 1);
      const points = data.map((d, i) => ({ d, x: data.length === 1 ? (width + pad.left - pad.right) / 2 : pad.left + step * i, v: d[valueKey] }));
      const y = (v) => height - pad.bottom - ((height - pad.top - pad.bottom) * v) / max;
      axes(svg, { width, height, pad, max, ticks, labels: xLabels(points, width, labelFor), format });
      let path = '';
      let pen = false;
      for (const p of points) {
        if (p.v === null || p.v === undefined) { pen = false; continue; }
        path += `${pen ? 'L' : 'M'}${p.x},${y(p.v)} `;
        pen = true;
      }
      svg.append(svgEl('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      for (const p of points) {
        const prev = points[points.indexOf(p) - 1];
        const next = points[points.indexOf(p) + 1];
        const isolated = p.v !== null && p.v !== undefined && (prev?.v === null || prev?.v === undefined) && (next?.v === null || next?.v === undefined);
        if (isolated) svg.append(svgEl('circle', { cx: p.x, cy: y(p.v), r: 4, fill: color, class: 'viz-dot' }));
      }
      const cross = svgEl('line', { y1: pad.top, y2: height - pad.bottom, class: 'viz-cross', visibility: 'hidden' });
      const dot = svgEl('circle', { r: 4, fill: color, class: 'viz-dot', visibility: 'hidden' });
      svg.append(cross, dot);
      const hit = svgEl('rect', { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom, fill: 'transparent', tabindex: 0 });
      let idx = points.length - 1;
      const showAt = (i) => {
        const p = points[i];
        if (!p) return;
        cross.setAttribute('x1', p.x);
        cross.setAttribute('x2', p.x);
        cross.setAttribute('visibility', 'visible');
        if (p.v !== null && p.v !== undefined) {
          dot.setAttribute('cx', p.x);
          dot.setAttribute('cy', y(p.v));
          dot.setAttribute('visibility', 'visible');
        } else dot.setAttribute('visibility', 'hidden');
        showTip(tip, svg.parentElement, p.x, p.v !== null && p.v !== undefined ? y(p.v) - 30 : pad.top, tipFor(p.d), [{ color, label, value: p.v === null || p.v === undefined ? 'no runs' : format(p.v) }]);
      };
      const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
      hit.addEventListener('pointermove', (e) => {
        const bx = svg.getBoundingClientRect();
        const x = e.clientX - bx.left;
        idx = points.reduce((best, p, i) => (Math.abs(p.x - x) < Math.abs(points[best].x - x) ? i : best), 0);
        showAt(idx);
      });
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', () => showAt(idx));
      hit.addEventListener('blur', hide);
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { idx = Math.max(0, idx - 1); showAt(idx); }
        if (e.key === 'ArrowRight') { idx = Math.min(points.length - 1, idx + 1); showAt(idx); }
      });
      svg.append(hit);
    },
  });
}

/** Horizontal bar list (one series): label, bar, value. Values stay as text so nothing needs a hover. */
export function barList(items, { format = compact, max } = {}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return h('div', { class: 'bar-list' }, items.map((i) => h('div', { class: 'bar-row', title: i.title ?? '' },
    h('span', { class: 'truncate' }, i.label),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${Math.max(1, (i.value / top) * 100)}%` } })),
    h('span', { class: 'num' }, format(i.value)))));
}
