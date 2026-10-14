const flowId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const status = $('status');
const results = $('results');
const primary = params.get('color');
if (primary && /^#?[0-9a-f]{3,8}$/i.test(primary)) document.documentElement.style.setProperty('--brand', primary.startsWith('#') ? primary : `#${primary}`);
if (params.get('placeholder')) $('q').placeholder = params.get('placeholder').slice(0, 120);

const text = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function render(list) {
  results.replaceChildren();
  for (const r of list) {
    const item = document.createElement('article');
    item.className = 'result';
    const crumbs = Array.isArray(r.breadcrumbs) ? r.breadcrumbs.map(text).join(' › ') : text(r.breadcrumbs ?? r.group ?? r.tab);
    if (crumbs) item.append(Object.assign(document.createElement('div'), { className: 'crumbs', textContent: crumbs }));
    const h3 = document.createElement('h3');
    const link = text(r.link ?? r.referenceLink);
    const title = text(r.title) || link || 'Result';
    if (/^https?:/i.test(link)) h3.append(Object.assign(document.createElement('a'), { href: link, target: '_top', rel: 'noopener', textContent: title }));
    else h3.textContent = title;
    item.append(h3);
    const body = text(r.content ?? r.referenceText);
    if (body) item.append(Object.assign(document.createElement('p'), { textContent: body.length > 400 ? `${body.slice(0, 400)}…` : body }));
    results.append(item);
  }
}

async function search(q) {
  const query = q.trim();
  if (!query) return;
  status.className = 'status';
  status.textContent = 'Searching…';
  results.style.opacity = '0.5';
  try {
    const res = await fetch(`/api/search/${encodeURIComponent(flowId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchQuery: query }) });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== 'success') throw new Error(body?.errors?.[0]?.message ?? body?.error?.message ?? `Search failed (${res.status})`);
    render(body.results);
    status.textContent = body.results.length ? `${body.results.length} result${body.results.length === 1 ? '' : 's'}` : 'No results found.';
    const url = new URL(location.href);
    url.searchParams.set('q', query);
    history.replaceState(null, '', url);
  } catch (e) {
    status.className = 'status error';
    status.textContent = e.message;
  } finally {
    results.style.opacity = '';
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  void search($('q').value);
});
if (params.get('q')) {
  $('q').value = params.get('q');
  void search(params.get('q'));
}
$('q').focus();

// When embedded by /widget/search.js, report the content height so the iframe can grow (and shrink) with the results.
// html/body are height:100% (they fill the frame), so measure the content element rather than the document.
if (parent !== window) {
  const content = document.querySelector('main');
  let last = -1;
  const report = () => {
    const height = Math.ceil(content.getBoundingClientRect().bottom + window.scrollY);
    if (height === last) return;
    last = height;
    parent.postMessage({ type: 'jasmine:height', flowId, height }, '*');
  };
  new ResizeObserver(report).observe(content);
  report();
}
