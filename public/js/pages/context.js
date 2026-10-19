import { api } from '../api.js';
import { button, bytes, confirmDialog, emptyState, field, fill, h, input, modal, num, page, select, table, tabs, timeAgo, toast } from '../ui.js';

export async function render(container, _params, { navigate, query }) {
  let tab = query.get('tab') ?? 'knowledge';
  const body = h('div');
  const head = h('div');
  const draw = async () => {
    fill(head, tabs([
      { id: 'knowledge', label: 'Document collections', icon: 'database' }, { id: 'memory', label: 'Memory stores', icon: 'memory' },
      { id: 'tables', label: 'Tables', icon: 'table' }, { id: 'files', label: 'Files', icon: 'file' },
    ], tab, (t) => { tab = t; history.replaceState(null, '', `/context?tab=${t}`); void draw(); }));
    fill(body, h('div', { class: 'page-loading' }, h('span', { class: 'spinner' })));
    const view = await ({ knowledge: () => collections('knowledge', navigate, query.get('create')), memory: () => collections('memory', navigate), tables: () => tablesView(), files: () => filesView() })[tab]();
    fill(body, view);
  };
  container.append(page('Knowledge', 'What your workflows can use: document collections for answering questions and search, memory stores for long-term chat memory, data tables, and uploaded files.', [], head, body));
  await draw();
}

async function collections(kind, navigate, prefill) {
  const [list, models] = await Promise.all([api.get(`/api/collections?kind=${kind}`), api.get('/api/models').catch(() => [])]);
  const create = (initial = '') => {
    let name = initial;
    let description = '';
    let model = '';
    const embeddingOptions = [{ value: '', label: 'Project default embedding model' }, ...models.filter((m) => m.ok).flatMap((m) => m.models.filter((x) => x.kind === 'embedding').map((x) => ({ value: `${m.connection}::${x.id}`, label: `${m.name}: ${x.id}` })))];
    modal({
      title: kind === 'knowledge' ? 'New knowledge collection' : 'New memory store',
      body: h('div', { class: 'stack' },
        field('Name', input(initial, (v) => (name = v), { placeholder: kind === 'knowledge' ? 'handbook' : 'user-memories' }), initial ? 'A workflow refers to this name, so keep it unless you also change the workflow.' : 'Letters, digits, dots, dashes; workflows reference it by this name.'),
        field('Description', input('', (v) => (description = v))),
        field('Embedding model', select(embeddingOptions, '', (v) => (model = v)), 'Every passage in a collection uses the same embedding model. A learned model (for example nomic-embed-text) searches by meaning. The built-in keyword option needs no model server but only matches shared words.')),
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Create', kind: 'primary', onClick: async (close) => {
        const [connection, embeddingModel] = model ? model.split('::') : [null, null];
        try {
          await api.post('/api/collections', { name: name.trim(), description, kind, embeddingConnection: connection, embeddingModel });
          close();
          if (kind === 'knowledge') navigate(`/context/${encodeURIComponent(name.trim())}`);
          else navigate('/context?tab=memory');
        } catch (e) {
          toast(e.message, 'error');
        }
      } }],
    });
  };
  if (prefill && kind === 'knowledge') {
    history.replaceState(null, '', '/context');
    if (list.some((c) => c.name === prefill)) setTimeout(() => navigate(`/context/${encodeURIComponent(prefill)}`));
    else setTimeout(() => create(prefill));
  }
  return h('div', { class: 'stack' },
    h('div', { class: 'row spread' }, h('p', { class: 'muted' }, kind === 'knowledge' ? 'Upload documents to a collection, then use it in “Answer from your documents” (RAG) or search steps.' : 'Used by Memory Add and Memory Retrieve steps; records are scoped by user and session.'),
      button(kind === 'knowledge' ? 'New collection' : 'New memory store', { kind: 'primary', icon: 'plus', onClick: () => create() })),
    table([
      { label: 'Name', render: (c) => h('div', {}, h('div', { class: 'cell-title' }, c.name), c.description ? h('div', { class: 'cell-sub' }, c.description) : null) },
      { label: 'Records', class: 'num', render: (c) => num(c.records) },
      ...(kind === 'knowledge' ? [{ label: 'Documents', class: 'num', render: (c) => num(c.documents) }] : []),
      { label: 'Embedding model', render: (c) => c.embeddingModel ? h('code', {}, `${c.embeddingConnection ?? 'default'} · ${c.embeddingModel}`) : h('span', { class: 'muted' }, 'default (set on first write)') },
      { label: 'Dimensions', class: 'num', render: (c) => c.dimension ?? '—' },
      { label: 'Updated', render: (c) => h('span', { class: 'muted' }, timeAgo(c.updatedAt)) },
    ], list, {
      onRowClick: (c) => navigate(`/context/${encodeURIComponent(c.name)}`),
      empty: emptyState(kind === 'knowledge' ? 'database' : 'memory', kind === 'knowledge' ? 'No knowledge collections yet' : 'No memory stores yet',
        kind === 'knowledge' ? 'Create one, then upload PDFs, Word files, web pages or text. Jasmine chunks and embeds them locally.' : 'Memory stores are created automatically the first time a Memory Add node writes to one.',
        button('Create', { kind: 'primary', icon: 'plus', onClick: () => create() })),
    }));
}

async function tablesView() {
  const list = await api.get('/api/tables');
  const wrap = h('div', { class: 'stack' });
  const create = () => {
    let name = '';
    const columns = [{ name: 'name', type: 'text' }];
    const cols = h('div', { class: 'stack-sm' });
    const drawCols = () => fill(cols, columns.map((c, i) => h('div', { class: 'row' },
      input(c.name, (v) => (columns[i].name = v), { placeholder: 'column' }),
      select(['text', 'number', 'integer', 'boolean', 'json'], c.type, (v) => (columns[i].type = v), { style: 'width:120px' }),
      button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove column', onClick: () => { columns.splice(i, 1); drawCols(); } }))),
    button('Add column', { icon: 'plus', size: 'sm', onClick: () => { columns.push({ name: '', type: 'text' }); drawCols(); } }));
    drawCols();
    modal({
      title: 'New table', body: h('div', { class: 'stack' }, field('Table name', input('', (v) => (name = v), { placeholder: 'leads' })), h('div', { class: 'field-label' }, 'Columns (id, created_at and updated_at are added automatically)'), cols),
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Create table', kind: 'primary', onClick: async (close) => {
        try {
          await api.post('/api/tables', { name, columns: columns.filter((c) => c.name) });
          close();
          openTable(name);
          toast('Table created', 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
      } }],
    });
  };
  const openTable = async (name) => {
    const data = await api.get(`/api/tables/${encodeURIComponent(name)}/rows?limit=200`);
    const info = (await api.get('/api/tables')).find((t) => t.name === name);
    const columns = info?.columns ?? [];
    const draft = {};
    const body = h('div', { class: 'stack' },
      h('div', { class: 'row row-wrap' }, columns.map((c) => input('', (v) => (draft[c.name] = v), { placeholder: `${c.name} (${c.type})`, style: 'width:160px' })),
        button('Add row', { icon: 'plus', kind: 'primary', size: 'sm', onClick: async () => {
          try {
            const typed = Object.fromEntries(Object.entries(draft).map(([k, v]) => {
              const t = columns.find((c) => c.name === k)?.type;
              return [k, t === 'json' ? JSON.parse(v || 'null') : v];
            }));
            await api.post(`/api/tables/${encodeURIComponent(name)}/rows`, { data: typed });
            m.close();
            openTable(name);
          } catch (e) {
            toast(e.message, 'error');
          }
        } })),
      table([{ label: 'id', render: (r) => r.id }, ...columns.map((c) => ({ label: c.name, render: (r) => (typeof r[c.name] === 'object' && r[c.name] !== null ? JSON.stringify(r[c.name]) : String(r[c.name] ?? '')) })),
        { label: '', class: 'num', render: (r) => button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete row', onClick: async () => { await api.del(`/api/tables/${encodeURIComponent(name)}/rows/${r.id}`); m.close(); openTable(name); } }) }],
      data.rows, { empty: h('p', { class: 'muted' }, 'No rows yet. Add rows here or with a Tables node.') }),
      h('p', { class: 'muted small' }, `${data.count} row(s). Flows read and write this table with the Tables node.`));
    const m = modal({ title: `Table: ${name}`, body, wide: true, actions: [{ label: 'Delete table', kind: 'danger', icon: 'trash', onClick: async (close) => {
      if (!await confirmDialog(`Delete table ${name} and all its rows?`, { danger: true, confirmLabel: 'Delete' })) return;
      await api.del(`/api/tables/${encodeURIComponent(name)}`);
      close();
      fill(wrap, await tablesView());
    } }] });
  };
  wrap.append(h('div', { class: 'row spread' }, h('p', { class: 'muted' }, 'Typed tables in a local SQLite database, for flows that need to store or look up structured data.'), button('New table', { kind: 'primary', icon: 'plus', onClick: create })),
    table([{ label: 'Table', render: (t) => h('span', { class: 'cell-title' }, t.name) }, { label: 'Columns', render: (t) => t.columns.map((c) => `${c.name}:${c.type}`).join(', ') }, { label: 'Rows', class: 'num', render: (t) => num(t.rows) }],
      list, { onRowClick: (t) => openTable(t.name), empty: emptyState('table', 'No tables yet', 'Create a table to store leads, tickets, results or any structured data your flows produce.') }));
  return wrap;
}

async function filesView() {
  const list = await api.get('/api/files');
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', onChange: async (e) => {
    for (const f of e.target.files) {
      try {
        await api.upload(f);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    toast('Uploaded', 'success');
    const view = await filesView();
    wrap.replaceWith(view);
  } });
  const wrap = h('div', { class: 'stack' },
    h('div', { class: 'row spread' }, h('p', { class: 'muted' }, 'Uploaded files can be used anywhere a file URL is accepted, as file:<id> (for example in Extract from File).'), h('div', {}, fileInput, button('Upload files', { kind: 'primary', icon: 'upload', onClick: () => fileInput.click() }))),
    table([
      { label: 'File', render: (f) => h('div', {}, h('div', { class: 'cell-title' }, f.name), h('code', { class: 'cell-sub' }, f.url)) },
      { label: 'Type', render: (f) => h('span', { class: 'muted' }, f.mime) },
      { label: 'Size', class: 'num', render: (f) => bytes(f.size) },
      { label: 'Uploaded', render: (f) => timeAgo(f.createdAt) },
      { label: '', class: 'num', render: (f) => h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        button('', { icon: 'copy', kind: 'ghost', size: 'sm', title: 'Copy reference', onClick: () => navigator.clipboard.writeText(f.url).then(() => toast('Copied', 'success')) }),
        button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete', onClick: async () => { await api.del(`/api/files/${f.id}`); wrap.replaceWith(await filesView()); } })) },
    ], list, { empty: emptyState('file', 'No files', 'Upload documents for testing extraction, or use them as knowledge sources.') }));
  return wrap;
}
