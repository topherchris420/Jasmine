import { api } from '../api.js';
import { badge, button, bytes, confirmDialog, emptyState, field, fill, h, icon, input, jsonPanel, modal, ms, num, page, select, statusBadge, table, tabs, textarea, timeAgo, toast } from '../ui.js';

export async function render(container, { name }, { navigate }) {
  let info = await api.get(`/api/collections/${encodeURIComponent(name)}`);
  let tab = info.kind === 'memory' ? 'records' : 'documents';
  const body = h('div');
  const head = h('div');
  let poll = null;

  const draw = async () => {
    clearTimeout(poll);
    info = await api.get(`/api/collections/${encodeURIComponent(name)}`);
    fill(head, 
      h('div', { class: 'grid grid-4', style: { marginBottom: '14px' } },
        stat('Records', num(info.records)), stat('Documents', num(info.documents)), stat('Dimensions', info.dimension ?? '—'),
        stat('Embedding model', info.embeddingModel ? `${info.embeddingModel}` : 'default', info.embeddingConnection ?? '')),
      tabs([
        ...(info.kind === 'knowledge' ? [{ id: 'documents', label: 'Documents', icon: 'file', count: info.documents }] : []),
        { id: 'search', label: 'Search playground', icon: 'search' }, { id: 'records', label: 'Records', icon: 'database', count: info.records }, { id: 'settings', label: 'Settings', icon: 'settings' },
      ], tab, (t) => { tab = t; void draw(); }));
    fill(body, await views[tab]());
  };

  const views = {
    async documents() {
      const docs = await api.get(`/api/collections/${encodeURIComponent(name)}/documents`);
      if (docs.some((d) => d.status === 'processing')) poll = setTimeout(() => void draw(), 1500);
      return h('div', { class: 'stack' },
        h('div', { class: 'row spread' }, h('p', { class: 'muted' }, 'Documents are extracted, split into chunks, embedded with this database’s model and indexed for vector and keyword search.'), button('Add documents', { kind: 'primary', icon: 'plus', onClick: () => addDocuments(name, () => void draw()) })),
        table([
          { label: 'Document', render: (d) => h('div', {}, h('div', { class: 'cell-title' }, d.title), h('div', { class: 'cell-sub truncate', style: { maxWidth: '420px' } }, d.source)) },
          { label: 'Status', render: (d) => h('div', {}, d.status === 'processing' ? h('span', { class: 'row' }, h('span', { class: 'spinner', style: { width: '12px', height: '12px' } }), 'processing') : statusBadge(d.status), d.error ? h('div', { class: 'cell-sub', style: { color: 'var(--danger)' } }, d.error) : null) },
          { label: 'Chunks', class: 'num', render: (d) => num(d.chunks) },
          { label: 'Size', class: 'num', render: (d) => (d.bytes ? bytes(d.bytes) : '—') },
          { label: 'Added', render: (d) => h('span', { class: 'muted' }, timeAgo(d.createdAt)) },
          { label: '', class: 'num', render: (d) => button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remove document and its chunks', onClick: async () => {
            if (!await confirmDialog(`Remove “${d.title}” and its ${d.chunks} chunk(s)?`, { danger: true, confirmLabel: 'Remove' })) return;
            await api.del(`/api/documents/${d.id}`);
            void draw();
          } }) },
        ], docs, { empty: emptyState('file', 'No documents yet', 'Upload PDF, Word, PowerPoint, Excel, HTML, Markdown, CSV or text files, paste text, or index web pages.', button('Add documents', { kind: 'primary', icon: 'plus', onClick: () => addDocuments(name, () => void draw()) })) }));
    },
    async search() {
      let q = '';
      let mode = 'hybrid';
      let limit = 5;
      const results = h('div', { class: 'stack' });
      const run = async () => {
        if (!q.trim()) return;
        fill(results, h('span', { class: 'spinner' }));
        try {
          const res = await api.post(`/api/collections/${encodeURIComponent(name)}/search`, { query: q, mode, limit });
          fill(results, h('div', { class: 'muted small' }, `${res.hits.length} result(s) in ${ms(res.latencyMs)}`),
            res.hits.length ? res.hits.map((hit, i) => h('div', { class: 'card', style: { padding: '12px 14px' } },
              h('div', { class: 'row', style: { marginBottom: '6px' } }, h('strong', {}, `#${i + 1}`), h('span', { class: 'cell-title grow truncate' }, String(hit.metadata.title ?? hit.metadata.source ?? hit.id)),
                badge(`score ${hit.score.toFixed(3)}`, 'accent'), hit.certainty !== undefined ? badge(`certainty ${hit.certainty.toFixed(3)}`, 'neutral') : null, hit.keywordScore !== undefined ? badge(`bm25 ${hit.keywordScore.toFixed(2)}`, 'neutral') : null),
              h('div', { style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, hit.text.slice(0, 900)),
              hit.metadata.page ? h('div', { class: 'muted small' }, `page ${hit.metadata.page}`) : null)) : h('p', { class: 'muted' }, 'No matches.'));
        } catch (e) {
          fill(results, h('div', { class: 'callout callout-danger' }, icon('alert'), e.message));
        }
      };
      const box = input('', (v) => (q = v), { placeholder: 'Ask or search…' });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') void run(); });
      setTimeout(() => box.focus());
      return h('div', { class: 'stack' },
        h('div', { class: 'row' }, box,
          select([{ value: 'hybrid', label: 'Hybrid' }, { value: 'vector', label: 'Semantic' }, { value: 'keyword', label: 'Keyword (BM25)' }], mode, (v) => (mode = v), { style: 'width:150px' }),
          select(['3', '5', '10', '20'], String(limit), (v) => (limit = Number(v)), { style: 'width:80px' }),
          button('Search', { kind: 'primary', icon: 'search', onClick: run })),
        results);
    },
    async records() {
      let offset = 0;
      const wrap = h('div', { class: 'stack' });
      const load = async () => {
        const data = await api.get(`/api/collections/${encodeURIComponent(name)}/records?limit=25&offset=${offset}`);
        fill(wrap, 
          table([
            { label: 'Id', render: (r) => h('code', { class: 'small' }, r.id.length > 24 ? `${r.id.slice(0, 24)}…` : r.id) },
            { label: 'Text', render: (r) => h('div', { class: 'truncate', style: { maxWidth: '560px' } }, r.text) },
            { label: 'Metadata', render: (r) => h('span', { class: 'muted small' }, Object.keys(r.metadata).filter((k) => k !== 'content').slice(0, 5).join(', ')) },
            { label: '', class: 'num', render: (r) => button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete record', onClick: async () => { await api.del(`/api/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(r.id)}`); void load(); } }) },
          ], data.records, { onRowClick: (r) => modal({ title: 'Record', body: jsonPanel(r), wide: true }), empty: h('p', { class: 'muted' }, 'No records.') }),
          h('div', { class: 'row' }, h('span', { class: 'muted small grow' }, `${offset + 1}–${Math.min(offset + 25, data.total)} of ${data.total}`),
            button('Previous', { size: 'sm', disabled: offset === 0, onClick: () => { offset = Math.max(0, offset - 25); void load(); } }),
            button('Next', { size: 'sm', disabled: offset + 25 >= data.total, onClick: () => { offset += 25; void load(); } })));
      };
      await load();
      return wrap;
    },
    async settings() {
      let description = info.description;
      return h('div', { class: 'stack', style: { maxWidth: '640px' } },
        field('Description', input(description, (v) => (description = v))),
        h('div', {}, button('Save', { kind: 'primary', onClick: async () => { await api.put(`/api/collections/${encodeURIComponent(name)}`, { description }); toast('Saved', 'success'); } })),
        h('div', { class: 'callout' }, icon('info'), h('div', {}, h('strong', {}, 'Embedding model'), h('p', {}, info.embeddingModel
          ? `Records were embedded with ${info.embeddingModel} (${info.embeddingConnection}). To switch models, clear the database and re-add documents.`
          : 'Set automatically by the first document or Index node that writes here.'))),
        h('div', { class: 'row' },
          button('Clear all records', { icon: 'refresh', onClick: async () => {
            if (!await confirmDialog(`Remove all ${info.records} records and documents from ${name}?`, { danger: true, confirmLabel: 'Clear' })) return;
            await api.post(`/api/collections/${encodeURIComponent(name)}/clear`);
            toast('Cleared', 'success');
            void draw();
          } }),
          button('Delete database', { kind: 'danger', icon: 'trash', onClick: async () => {
            if (!await confirmDialog(`Delete ${name}? Flows that use it will fail until it is recreated.`, { danger: true, confirmLabel: 'Delete' })) return;
            await api.del(`/api/collections/${encodeURIComponent(name)}`);
            navigate(info.kind === 'memory' ? '/context?tab=memory' : '/context');
          } })));
    },
  };

  container.append(page(name, info.kind === 'memory' ? 'Memory store' : 'Vector database', [button('Back', { icon: 'chevronLeft', kind: 'ghost', onClick: () => navigate(info.kind === 'memory' ? '/context?tab=memory' : '/context') })], head, body));
  await draw();
  return () => clearTimeout(poll);
}

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value truncate', style: { fontSize: String(value).length > 12 ? '16px' : '' } }, value), note ? h('div', { class: 'stat-note' }, note) : null);
}

function addDocuments(collection, done) {
  let mode = 'upload';
  let text = '';
  let title = '';
  let url = '';
  let chunkSize = 1000;
  let overlap = 150;
  let crawlLimit = 20;
  const files = [];
  const body = h('div', { class: 'stack' });
  const draw = () => {
    const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', accept: '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.html,.htm,.csv,.json,.xml', onChange: (e) => { files.push(...e.target.files); draw(); } });
    fill(body, 
      tabs([{ id: 'upload', label: 'Upload files', icon: 'upload' }, { id: 'text', label: 'Paste text', icon: 'edit' }, { id: 'url', label: 'Web page', icon: 'globe' }, { id: 'crawl', label: 'Crawl a site', icon: 'globe' }], mode, (m) => { mode = m; draw(); }),
      mode === 'upload' ? h('div', { class: 'stack' }, h('div', { class: 'row' }, fileInput, button('Choose files', { icon: 'file', onClick: () => fileInput.click() }), h('span', { class: 'muted small' }, 'PDF, Word, PowerPoint, Excel, HTML, Markdown, CSV, JSON, text (25 MB each)')),
        files.length ? h('div', { class: 'stack-sm' }, files.map((f) => h('div', { class: 'row small' }, icon('file', 14), f.name, h('span', { class: 'muted' }, bytes(f.size))))) : null) : null,
      mode === 'text' ? h('div', { class: 'stack' }, field('Title', input(title, (v) => (title = v))), field('Text', textarea(text, (v) => (text = v), { rows: 10 }))) : null,
      mode === 'url' || mode === 'crawl' ? h('div', { class: 'stack' }, field(mode === 'url' ? 'Page URL' : 'Start URL', input(url, (v) => (url = v), { placeholder: 'https://docs.example.com/' })),
        mode === 'crawl' ? field('Max pages', input(crawlLimit, (v) => (crawlLimit = Number(v) || 20), { type: 'number' }), 'Follows links on the same site and respects robots.txt.') : null) : null,
      h('div', { class: 'grid grid-2' }, field('Chunk size (characters)', input(chunkSize, (v) => (chunkSize = Number(v) || 1000), { type: 'number' })), field('Overlap (characters)', input(overlap, (v) => (overlap = Number(v) || 0), { type: 'number' }))));
  };
  draw();
  modal({
    title: 'Add documents', body, wide: true,
    actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Add', kind: 'primary', icon: 'plus', onClick: async (close) => {
      try {
        const common = { chunkSize, chunkOverlap: overlap };
        if (mode === 'upload') {
          if (!files.length) return toast('Choose at least one file', 'error');
          for (const f of files) {
            const stored = await api.upload(f);
            await api.post(`/api/collections/${encodeURIComponent(collection)}/documents`, { type: 'file', fileId: stored.id, ...common });
          }
        } else if (mode === 'text') await api.post(`/api/collections/${encodeURIComponent(collection)}/documents`, { type: 'text', text, title, ...common });
        else await api.post(`/api/collections/${encodeURIComponent(collection)}/documents`, { type: mode, url, ...common, ...(mode === 'crawl' ? { crawlLimit } : {}) });
        close();
        toast('Processing started', 'success');
        done();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }],
  });
}
