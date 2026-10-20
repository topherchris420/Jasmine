import { api } from '../api.js';
import { badge, busy, button, card, codeBlock, confirmDialog, copyButton, dateTime, field, fill, h, icon, input, textarea, toggle, jsonPanel, modal, ms, page, statusBadge, table, tabs, timeAgo, toast } from '../ui.js';
import { lifecycleBadge, origin, triggerChip } from '../shared.js';
import { EXAMPLE_TEXT } from '../builder/graph.js';

/** Code snippets for calling a flow, shared with the API playground. */
export function snippets({ flowId, payload, key, base = origin() }) {
  const auth = key ? `Bearer ${key}` : null;
  const body = JSON.stringify({ query: 'mutation Run($workflowId: String!, $payload: JSON) { executeWorkflow(workflowId: $workflowId, payload: $payload) { status requestId result } }', variables: { workflowId: flowId, payload } });
  const restBody = JSON.stringify({ payload });
  return {
    curl: [`curl -X POST ${base}/graphql \\`, '  -H "Content-Type: application/json" \\', auth ? `  -H "Authorization: ${auth}" \\` : null, `  -d '${body.replaceAll("'", "'\\''")}'`].filter(Boolean).join('\n'),
    rest: [`curl -X POST ${base}/api/v1/flows/${flowId}/execute \\`, '  -H "Content-Type: application/json" \\', auth ? `  -H "Authorization: ${auth}" \\` : null, `  -d '${restBody.replaceAll("'", "'\\''")}'`].filter(Boolean).join('\n'),
    javascript: `const res = await fetch('${base}/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',${auth ? `\n    Authorization: '${auth}',` : ''}
  },
  body: JSON.stringify({
    query: \`mutation Run($workflowId: String!, $payload: JSON) {
      executeWorkflow(workflowId: $workflowId, payload: $payload) { status requestId result }
    }\`,
    variables: { workflowId: '${flowId}', payload: ${JSON.stringify(payload, null, 2).replace(/\n/g, '\n    ')} },
  }),
});
const { data } = await res.json();
console.log(data.executeWorkflow.result);`,
    python: `import requests

res = requests.post(
    "${base}/graphql",
    headers={${auth ? `"Authorization": "${auth}"` : ''}},
    json={
        "query": """mutation Run($workflowId: String!, $payload: JSON) {
          executeWorkflow(workflowId: $workflowId, payload: $payload) { status requestId result }
        }""",
        "variables": {"workflowId": "${flowId}", "payload": ${pyLiteral(payload)}},
    },
    timeout=300,
)
print(res.json()["data"]["executeWorkflow"]["result"])`,
  };
}

function pyLiteral(v) {
  return JSON.stringify(v).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None');
}

export function snippetTabs(sn) {
  let lang = 'curl';
  const box = h('div');
  const labels = { curl: 'cURL (GraphQL)', rest: 'cURL (REST)', javascript: 'JavaScript', python: 'Python' };
  const draw = () => box.replaceChildren(tabs(Object.keys(labels).map((id) => ({ id, label: labels[id] })), lang, (t) => { lang = t; draw(); }), codeBlock(sn[lang], labels[lang]));
  draw();
  return box;
}

/** The trigger of a deployed definition (canonical `{ type, trigger, values }` nodes, or editor-shaped ones). */
export function triggerInfo(definition) {
  const node = (definition?.nodes ?? []).find((n) => n.trigger === true || n.data?.trigger);
  if (!node) return { type: null, values: {} };
  return { type: node.data?.nodeId ?? node.type, values: node.values ?? node.data?.values ?? {} };
}

/** An example payload for a trigger, from its input schema when it has one. */
export function samplePayload({ type, values }) {
  if (type === 'chatTriggerNode' || type === 'askTriggerNode') return { chatMessage: 'Hello!' };
  if (type === 'searchTriggerNode') return { searchQuery: 'how do I reset my password' };
  let schema = values.advance_schema;
  try {
    schema = typeof schema === 'string' && schema.trim() ? JSON.parse(schema) : schema;
  } catch {
    schema = undefined;
  }
  if (!schema || typeof schema !== 'object') return {};
  const props = schema.properties && typeof schema.properties === 'object' ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v?.type ?? 'string'])) : schema;
  return Object.fromEntries(Object.entries(props).map(([k, t]) => [k, t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : t === 'object' ? {} : t === 'array' ? [] : EXAMPLE_TEXT[k] ?? '']));
}

function endpoint(method, url) {
  return h('div', { class: 'endpoint' }, h('span', { class: 'method' }, method), h('code', { title: url }, url), copyButton(url));
}

export async function render(container, params, ctx) {
  const { id } = params;
  const { navigate } = ctx;
  const reload = () => { container.replaceChildren(); return render(container, params, ctx); };
  const [flow, versions, settings, schedules, runs] = await Promise.all([
    api.get(`/api/flows/${encodeURIComponent(id)}`), api.get(`/api/flows/${encodeURIComponent(id)}/versions`), api.get('/api/settings'),
    api.get('/api/schedules'), api.get(`/api/runs?flowId=${encodeURIComponent(id)}&limit=10`).then((r) => r.runs),
  ]);
  const summary = flow.summary;
  if (!versions.active) {
    const latest = versions.versions[0];
    container.append(page(flow.name, h('span', { class: 'row' }, lifecycleBadge(summary), h('span', { class: 'muted' }, summary.lifecycle?.detail ?? 'Not deployed')), [button('Open in builder', { icon: 'edit', onClick: () => navigate(`/flows/${encodeURIComponent(id)}`) })],
      latest
        ? h('div', { class: 'callout callout-info' }, icon('info'), h('div', {}, h('strong', {}, 'Disabled'), h('p', {}, `This workflow was deployed before and is turned off. Version ${latest.version.slice(0, 12)} from ${dateTime(latest.deployedAt)} can be turned back on as it was.`),
          h('div', { class: 'row', style: { marginTop: '8px' } }, button(`Re-enable version ${latest.version.slice(0, 12)}`, { kind: 'primary', icon: 'play', onClick: async (e) => busy(e.currentTarget, async () => {
            if (!await confirmDialog(`Turn version ${latest.version.slice(0, 12)} back on? Its endpoints, widgets and schedules start working again.`, { confirmLabel: 'Re-enable' })) return;
            try { await api.post(`/api/flows/${encodeURIComponent(id)}/rollback`, { toVersion: latest.version }); toast('Re-enabled', 'success'); void reload(); } catch (err) { toast(err.message, 'error'); }
          }) }))))
        : h('div', { class: 'callout callout-info' }, icon('info'), h('div', {}, h('strong', {}, 'Not deployed yet'), h('p', {}, 'Open the builder, test the draft, then press Deploy. You review what becomes live before anything is published. Its API endpoint, webhook URL or widget code then appears here.')))));
    return;
  }
  const active = await api.get(`/api/flows/${encodeURIComponent(id)}/versions/${versions.active}`);
  const trigger = triggerInfo(active.definition);
  const type = trigger.type ?? summary.trigger;
  const values = trigger.values;
  const base = origin();
  const needsKey = settings.auth.executeEnabled;
  const keyHint = needsKey ? 'YOUR_API_KEY' : null;
  const payload = samplePayload({ type, values });
  const sections = [];

  if (type === 'chatTriggerNode' || type === 'askTriggerNode') {
    const hosted = `${base}/apps/chat/${id}`;
    const embed = `<script src="${base}/widget/chat.js" data-flow-id="${id}" defer></script>`;
    const iframe = `<iframe src="${hosted}" style="width:100%;height:600px;border:0" title="${values.chatConfig?.botName ?? 'Chat'}"></iframe>`;
    sections.push(card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, type === 'askTriggerNode' ? 'Ask widget' : 'Chat widget'), h('p', {}, 'Add a floating chat bubble to any site, embed the page in an iframe, or link to the hosted page.')),
      h('a', { class: 'btn btn-secondary btn-sm', href: hosted, target: '_blank', rel: 'noopener' }, icon('external', 14), h('span', {}, 'Open hosted page'))),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'stack' },
        h('div', { class: 'field-label' }, 'Floating widget (paste before </body>)'), codeBlock(embed, 'HTML'),
        h('div', { class: 'field-label' }, 'Inline iframe'), codeBlock(iframe, 'HTML'),
        h('div', { class: 'field-label' }, 'Hosted page'), endpoint('GET', hosted),
        h('div', { class: 'field-label' }, 'Chat API (streams with "stream": true)'), endpoint('POST', `${base}/api/${type === 'askTriggerNode' ? 'ask' : 'chat'}/${id}`),
        codeBlock(`curl -X POST ${base}/api/${type === 'askTriggerNode' ? 'ask' : 'chat'}/${id} \\\n  -H "Content-Type: application/json" \\\n  -d '{"chatMessage": "Hello!", "sessionId": "optional-session-id"}'`, 'cURL'),
        h('p', { class: 'muted small' }, `Allowed embedding domains: ${(values.domains ?? ['*']).join(', ') || '*'} (change them on the trigger node).`)),
      h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, 'Preview'), h('iframe', { class: 'preview-frame', src: `/apps/chat/${id}`, title: 'Widget preview' })))));
  }
  if (type === 'searchTriggerNode') {
    const hosted = `${base}/apps/search/${id}`;
    sections.push(card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Search widget'), h('p', {}, 'A search box with AI-ranked results from your knowledge.')),
      h('a', { class: 'btn btn-secondary btn-sm', href: hosted, target: '_blank', rel: 'noopener' }, icon('external', 14), h('span', {}, 'Open hosted page'))),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'stack' },
        h('div', { class: 'field-label' }, 'Embed'), codeBlock(`<div id="jasmine-search"></div>\n<script src="${base}/widget/search.js" data-flow-id="${id}" data-target="#jasmine-search" defer></script>`, 'HTML'),
        h('div', { class: 'field-label' }, 'Search API'), endpoint('POST', `${base}/api/search/${id}`),
        codeBlock(`curl -X POST ${base}/api/search/${id} \\\n  -H "Content-Type: application/json" \\\n  -d '{"searchQuery": "reset password"}'`, 'cURL')),
      h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, 'Preview'), h('iframe', { class: 'preview-frame', src: `/apps/search/${id}`, title: 'Search preview' })))));
  }
  if (type === 'webhookTriggerNode') {
    const url = `${base}/webhooks/${id}`;
    sections.push(card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Webhook'), h('p', {}, 'Any service that can POST JSON can trigger this flow. The response contains the flow output.'))),
      h('div', { class: 'stack' }, endpoint('POST', url),
        values.webhookSecret
          ? h('div', { class: 'callout callout-info' }, icon('lock'), h('div', {}, h('strong', {}, 'Signed requests required'), h('p', {}, 'Send the shared secret in the x-jasmine-signature header, or sign the raw body: x-jasmine-signature: sha256=<HMAC-SHA256 hex>.')))
          : h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Unauthenticated'), h('p', {}, 'Anyone who can reach this server can call the webhook. Set a shared secret on the trigger node for public deployments.'))),
        codeBlock(`curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\${values.webhookSecret ? '\n  -H "x-jasmine-signature: YOUR_SECRET" \\' : ''}\n  -d '${JSON.stringify(payload)}'`, 'cURL'))));
  }
  if (type === 'mailhookNode') {
    const mailbox=(await api.get('/api/mailhooks')).find(x=>x.flowId===id);
    sections.push(card(h('h2',{},'Inbound email'),h('p',{},'Send mail to this stable recipient through the local SMTP listener. Configure MAIL_PORT to start it with Jasmine.'),h('div',{class:'row'},h('code',{},mailbox?.address??'No recipient'),mailbox?copyButton(mailbox.address):null),h('p',{class:'muted small'},'Internet delivery requires your own mail relay or MX routing. Attachments and parsed message content are passed to the flow.')));
  }
  if (type === 'cronNode' || type === 'localFolderNode' || type === 'sourceTriggerNode') {
    const s = schedules.find((x) => x.flowId === id);
    sections.push(card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, type === 'cronNode' ? 'Schedule' : type==='sourceTriggerNode'?'Scheduled source':'Folder sync'), h('p', {}, type === 'cronNode' ? 'Runs automatically while the Jasmine server is up.' : type==='sourceTriggerNode'?`Polls ${values.sourceNodeType} and passes the returned records to the flow.`:`Watches ${values.folderPath || 'a folder'} and runs once per new or changed file.`)),
      button('Run now', { icon: 'play', size: 'sm', onClick: async () => {
        const r = await api.post(`/api/schedules/${encodeURIComponent(id)}/run`);
        if (r.requestId) navigate(`/logs/${r.requestId}`);
        else toast('Nothing to run', 'info');
      } })),
    s ? h('dl', { class: 'kv' },
      h('dt', {}, 'Cron'), h('dd', {}, h('code', {}, s.expression), s.timezone ? ` (${s.timezone})` : ''),
      h('dt', {}, 'Next run'), h('dd', {}, s.nextRunAt ? dateTime(s.nextRunAt) : '—'),
      h('dt', {}, 'Last run'), h('dd', {}, s.lastFiredAt ? h('span', { class: 'row' }, s.lastStatus ? statusBadge(s.lastStatus) : null, timeAgo(s.lastFiredAt)) : 'never'),
      s.error ? h('dt', {}, 'Error') : null, s.error ? h('dd', { style: { color: 'var(--danger)' } }, s.error) : null) : h('p', { class: 'muted' }, 'No active schedule.')));
  }

  // A real request to the live version, sent with this browser's session; it is logged like any other run.
  let testText = JSON.stringify(payload, null, 2);
  // Set below once the summary cards exist; a live test updates the Latest live run card.
  let showLiveRun = () => {};
  const testOut = h('div', { class: 'stack-sm' });
  sections.unshift(card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Test the live endpoint'), h('p', {}, 'Sends a real request to the deployed version (not the draft) and shows exactly what a caller receives. It appears in Runs.'))),
    h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
      h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, `POST /api/v1/flows/${id}/execute · payload`), textarea(testText, (v) => (testText = v), { mono: true, rows: 6 }),
        h('div', {}, button('Send request', { kind: 'primary', icon: 'play', onClick: async (e) => busy(e.currentTarget, async () => {
          let body;
          try { body = JSON.parse(testText || '{}'); } catch { toast('The payload is not valid JSON', 'error'); return; }
          const t0 = performance.now();
          try {
            const res = await api.post(`/api/v1/flows/${encodeURIComponent(id)}/execute`, { payload: body, mode: 'realtime' }, { timeoutMs: 150_000 });
            const ok = res.status === 'success';
            showLiveRun({ status: res.status, startedAt: new Date().toISOString(), durationMs: performance.now() - t0 });
            fill(testOut, h('div', { class: 'row row-wrap' }, badge(ok ? `${res.statusCode ?? 200} · success` : `${res.statusCode ?? 500} · ${res.status}`, ok ? 'success' : 'danger'), h('span', { class: 'muted small' }, `${ms(performance.now() - t0)} round trip`), res.version ? h('code', { class: 'small' }, `version ${res.version.slice(0, 12)}`) : null, h('a', { href: `/logs/${res.requestId}`, 'data-link': '', class: 'small' }, 'Open the trace →')),
              ok ? null : h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, res.error?.code ?? 'Failed'), h('p', {}, res.error?.message ?? ''))),
              jsonPanel(res.output ?? res.result ?? null, 'Response output'));
          } catch (err) {
            fill(testOut, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, `Request failed${err.status ? ` (HTTP ${err.status})` : ''}`), h('p', {}, err.message))));
          }
        }) }))),
      testOut)));

  const sn = snippets({ flowId: id, payload, key: keyHint, base });
  const cachePolicy=await api.get(`/api/flows/${encodeURIComponent(id)}/cache`);
  let cacheEnabled=cachePolicy.enabled,cacheTtl=cachePolicy.ttlSeconds;
  sections.push(card(h('h2',{},'Response caching'),h('p',{class:'muted'},'Opt-in cache for flows without declared side effects. Model, knowledge, credential, environment and version changes invalidate the key. A hit reuses its original execution record.'),toggle(cacheEnabled,v=>cacheEnabled=v,'Enable caching'),field('Lifetime in seconds',input(String(cacheTtl),v=>cacheTtl=Number(v),{type:'number',min:1,max:86400})),h('div',{class:'row'},button('Save policy',{onClick:async()=>{await api.put(`/api/flows/${encodeURIComponent(id)}/cache`,{enabled:cacheEnabled,ttlSeconds:cacheTtl});toast('Cache policy saved','success');}}),button('Clear cache',{onClick:async()=>{await api.del(`/api/flows/${encodeURIComponent(id)}/cache`);toast('Cache cleared','success');}}))));
  sections.push(card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'API'), h('p', {}, 'Every deployed flow can be run over GraphQL (executeWorkflow) or REST, whatever its trigger.')),
    h('a', { href: `/playground?flow=${encodeURIComponent(id)}`, 'data-link': '', class: 'btn btn-secondary btn-sm' }, icon('playground', 14), h('span', {}, 'Try in playground'))),
  h('div', { class: 'stack' },
    endpoint('POST', `${base}/graphql`), endpoint('POST', `${base}/api/v1/flows/${id}/execute`), endpoint('GET', `${base}/api/v1/runs/{requestId}`), endpoint('POST',`${base}/mcp`),
    needsKey
      ? h('div', { class: 'callout callout-info' }, icon('key'), h('div', {}, h('strong', {}, 'API key required'), h('p', {}, 'Send an execute or admin key as Authorization: Bearer <key>. '), h('a', { href: '/settings', 'data-link': '' }, 'Create a key in Settings →')))
      : h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'No API key configured'), h('p', {}, 'The API accepts unauthenticated calls from anyone who can reach this server. Create an API key in Settings before exposing Jasmine beyond localhost.'))),
    snippetTabs(sn),
    h('p', { class: 'muted small' }, 'Pass "mode": "async" (GraphQL argument or REST body field) to return immediately with a requestId, then poll checkStatus / GET /api/v1/runs/{requestId}.'))));

  const versionsTable = table([
    { label: 'Version', render: (v) => h('div', { class: 'row' }, h('code', {}, v.version.slice(0, 12)), v.active ? badge('active', 'success') : null) },
    { label: 'Deployed', render: (v) => h('span', { class: 'nowrap' }, dateTime(v.deployedAt)) },
    { label: '', class: 'num', render: (v) => h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      button('View', { size: 'sm', kind: 'ghost', onClick: async () => {
        const full = await api.get(`/api/flows/${encodeURIComponent(id)}/versions/${v.version}`);
        modal({ title: `Version ${v.version.slice(0, 12)}`, wide: true, body: jsonPanel(full.definition, 'Flow definition') });
      } }),
      v.active ? null : button('Roll back', { size: 'sm', icon: 'history', onClick: async () => {
        if (!await confirmDialog(`Make version ${v.version.slice(0, 12)} the live version? New runs use it immediately.`, { confirmLabel: 'Roll back' })) return;
        try {
          await api.post(`/api/flows/${encodeURIComponent(id)}/rollback`, { toVersion: v.version });
          toast('Rolled back', 'success');
          void reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      } })) },
  ], versions.versions);

  const lastLive = runs.find((r) => r.source !== 'studio');
  const liveStat = h('div', { class: 'stat' });
  showLiveRun = (run) => fill(liveStat, h('div', { class: 'stat-label' }, 'Latest live run'), h('div', { style: { marginTop: '6px' } }, run ? statusBadge(run.status) : h('span', { class: 'muted' }, 'none yet')), h('div', { class: 'stat-note' }, run ? `${timeAgo(run.startedAt)} · ${ms(run.durationMs)}` : 'Send a test request below'));
  showLiveRun(lastLive);
  sections.unshift(h('div', { class: 'grid grid-4 stats' },
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Status'), h('div', { style: { marginTop: '6px' } }, lifecycleBadge(summary)), h('div', { class: 'stat-note' }, summary.lifecycle?.detail ?? '')),
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Live version'), h('div', { class: 'stat-value', style: { fontSize: '18px' } }, h('code', {}, versions.active.slice(0, 12))), h('div', { class: 'stat-note' }, `deployed ${timeAgo(summary.deployedAt)}`)),
    liveStat,
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Runs on'), h('div', { class: 'stat-value', style: { fontSize: '15px' } }, 'Your Jasmine runtime'), h('div', { class: 'stat-note truncate', title: base }, base))));
  container.append(page(flow.name, h('span', { class: 'row row-wrap' }, triggerChip(type), h('span', { class: 'muted' }, '·'), h('span', {}, `version ${versions.active.slice(0, 12)}`), h('span', { class: 'muted' }, `· deployed ${timeAgo(summary.deployedAt)}`)), [
    button('Open in builder', { icon: 'edit', onClick: () => navigate(`/flows/${encodeURIComponent(id)}`) }),
    summary.draftChanged ? button('Deploy latest draft', { kind: 'primary', icon: 'deploy', onClick: async () => {
      if (!await confirmDialog('Make the current draft live? Callers immediately get the new version; you can roll back at any time.', { confirmLabel: 'Deploy draft' })) return;
      try {
        const r = await api.post(`/api/flows/${encodeURIComponent(id)}/deploy`, {});
        toast(`Deployed ${r.version.slice(0, 12)}`, 'success');
        void reload();
      } catch (e) {
        toast(e.message, 'error', 8000);
      }
    } }) : null,
    button('Disable', { kind: 'ghost', icon: 'stop', title: 'Undeploy: stop serving this workflow', onClick: async () => {
      if (!await confirmDialog(`Take ${flow.name} offline? Its API, webhook, widget and schedule stop working until you deploy again. Versions are kept, so you can re-enable it.`, { danger: true, confirmLabel: 'Disable' })) return;
      await api.post(`/api/flows/${encodeURIComponent(id)}/undeploy`);
      toast('Disabled. Versions are kept.', 'success');
      void reload();
    } }),
  ].filter(Boolean),
  summary.draftChanged ? h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'The draft differs from the live version'), h('p', {}, 'Callers still get the deployed version until you deploy the draft.'))) : null,
  ...sections,
  h('div', { class: 'grid grid-2' },
    card(h('div', { class: 'card-head' }, h('h2', {}, 'Versions')), versionsTable,
      versions.history.length ? h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small muted' }, 'Deploy history'),
        h('div', { class: 'stack-sm', style: { marginTop: '8px' } }, versions.history.map((e) => h('div', { class: 'row small' }, badge(e.action, e.action === 'undeploy' ? 'neutral' : 'accent'), e.version ? h('code', {}, e.version.slice(0, 12)) : null, h('span', { class: 'muted' }, dateTime(e.at)))))) : null),
    card(h('div', { class: 'card-head' }, h('h2', {}, 'Recent runs'), h('a', { href: `/logs?flowId=${encodeURIComponent(id)}`, 'data-link': '', class: 'small' }, 'All logs →')),
      table([
        { label: 'When', render: (r) => h('span', { class: 'nowrap' }, timeAgo(r.startedAt)) },
        { label: 'Source', render: (r) => r.source },
        { label: 'Status', render: (r) => statusBadge(r.status) },
        { label: 'Duration', class: 'num', render: (r) => ms(r.durationMs) },
      ], runs, { onRowClick: (r) => navigate(`/logs/${r.id}`), empty: h('p', { class: 'muted' }, 'No runs yet.') })))));
}
