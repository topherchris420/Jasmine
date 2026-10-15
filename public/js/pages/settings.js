import { api, getKey, setKey } from '../api.js';
import { setProjectName } from '../main.js';
import { badge, button, card, codeBlock, confirmDialog, copyButton, dateTime, downloadFile, field, fill, h, icon, input, modal, page, pretty, select, table, timeAgo, toast } from '../ui.js';

export async function render(container) {
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const [s, keys] = await Promise.all([api.get('/api/settings'), api.get('/api/keys')]);
    fill(body, project(s), apiKeys(keys, s.auth, draw), secrets(s.secrets, draw), envVars(s.env), retention(s.retention), exportCard(),backupCard());
  };
  container.append(page('Settings', 'Project details, API keys, secrets, environment variables and data retention.', [], body));
  await draw();
}

function project(s) {
  let name = s.project.name;
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Project'), h('p', {}, `Project ID ${s.project.id}. Optionally require this value in x-project-id for API callers.`))),
    h('div', { class: 'row', style: { alignItems: 'flex-end' } },
      h('div', { class: 'grow' }, field('Name', input(name, (v) => (name = v)))),
      button('Save', { kind: 'primary', onClick: async () => {
        const info = await api.put('/api/settings/project', { name });
        setProjectName(info.name);
        toast('Project saved', 'success');
      } })));
}

function apiKeys(keys, auth, refresh) {
  const create = () => {
    let name = '';
    let scope = 'execute';
    modal({
      title: 'Create API key',
      body: h('div', { class: 'stack' },
        field('Name', input('', (v) => (name = v), { placeholder: 'website-backend' })),
        field('Scope', select([{ value: 'execute', label: 'Execute: run deployed flows and read their status' }, { value: 'admin', label: 'Admin: full access, including the Studio' }], scope, (v) => (scope = v)))),
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Create key', kind: 'primary', icon: 'key', onClick: async (close) => {
        try {
          const res = await api.post('/api/keys', { name, scope });
          close();
          const first = scope === 'admin' && !auth.adminEnabled;
          if (first) { await api.post('/api/auth/session', { apiKey: res.token }); setKey(''); }
          modal({
            title: 'Copy your new key',
            body: h('div', { class: 'stack' },
              h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'This is the only time the key is shown.'), h('p', {}, 'Store it in your application\'s secrets. Jasmine keeps only a hash.'))),
              h('div', { class: 'row' }, h('div', { class: 'secret-token grow' }, res.token), copyButton(res.token, 'Copy')),
              first ? h('p', { class: 'muted small' }, 'This is the first admin key, so the Studio and admin API now require it. This browser is now signed in with a revocable session.') : null,
              codeBlock(`curl -H "Authorization: Bearer ${res.token}" ${location.origin}/api/v1/runs/<requestId>`, 'Usage')),
            actions: [{ label: 'Done', kind: 'primary', onClick: (c) => c() }],
            onClose: () => { if (first) location.reload(); else refresh(); },
          });
        } catch (e) {
          toast(e.message, 'error');
        }
      } }],
    });
  };
  const active = keys.filter((k) => !k.revokedAt);
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'API keys'), h('p', {}, 'Keys authenticate calls to the GraphQL and REST APIs. Without an execute key the execution API is open; without an admin key so is the Studio.')),
    button('Create key', { kind: 'primary', icon: 'plus', onClick: create })),
  h('div', { class: 'row row-wrap', style: { marginBottom: '10px' } },
    auth.adminEnabled ? badge('Studio & admin API: key required', 'success') : badge('Studio & admin API: open (no admin key)', 'warning'),
    auth.executeEnabled ? badge('Execution API: key required', 'success') : badge('Execution API: open (no execute key)', 'warning')),
  table([
    { label: 'Name', render: (k) => h('span', { class: 'cell-title' }, k.name || '(unnamed)') },
    { label: 'Key', render: (k) => h('code', {}, `${k.prefix}…`) },
    { label: 'Scope', render: (k) => badge(k.scope, k.scope === 'admin' ? 'accent' : 'neutral') },
    { label: 'Created', render: (k) => h('span', { class: 'muted nowrap' }, dateTime(k.createdAt)) },
    { label: 'Last used', render: (k) => h('span', { class: 'muted nowrap' }, k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never') },
    { label: '', class: 'num', render: (k) => button('Revoke', { size: 'sm', kind: 'ghost', icon: 'trash', onClick: async () => {
      const lastAdmin = k.scope === 'admin' && active.filter((x) => x.scope === 'admin').length === 1;
      if (!await confirmDialog(lastAdmin ? `Revoke ${k.name || 'this key'}? It is the last admin key, so the Studio becomes open to anyone who can reach this server.` : `Revoke ${k.name || 'this key'}? Applications using it stop working immediately.`, { danger: true, confirmLabel: 'Revoke' })) return;
      await api.del(`/api/keys/${k.id}`);
      if (lastAdmin) setKey('');
      refresh();
    } }) },
  ], active, { empty: h('p', { class: 'muted' }, 'No API keys. Create an admin key before exposing Jasmine beyond this machine.') }),
  getKey() ? h('p', { class: 'muted small' }, 'This browser stores an admin key. Use the sidebar key control to forget it.') : null);
}

function secrets(names, refresh) {
  const edit = (existing) => {
    let name = existing ?? '';
    let value = '';
    modal({
      title: existing ? `Update ${existing}` : 'Add secret',
      body: h('div', { class: 'stack' },
        existing ? null : field('Name', input('', (v) => (name = v), { placeholder: 'OPENWEATHER_API_KEY' }), 'Letters, digits and underscores.'),
        field('Value', input('', (v) => (value = v), { type: 'password', autocomplete: 'off' }))),
      actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Save', kind: 'primary', onClick: async (close) => {
        try {
          await api.put(`/api/settings/secrets/${encodeURIComponent(name.trim())}`, { value });
          close();
          toast('Secret saved', 'success');
          refresh();
        } catch (e) {
          toast(e.message, 'error');
        }
      } }],
    });
  };
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Secrets'), h('p', {}, 'Encrypted values for flows: use {{secrets.project.NAME}} in any node field. Values are write-only and redacted from logs.')),
    button('Add secret', { icon: 'plus', onClick: () => edit(null) })),
  names.length ? h('div', { class: 'stack-sm' }, names.map((n) => h('div', { class: 'cred-row row' }, icon('lock', 14), h('code', { class: 'grow' }, n), h('code', { class: 'muted small' }, `{{secrets.project.${n}}}`),
    button('', { icon: 'edit', kind: 'ghost', size: 'sm', title: 'Update value', onClick: () => edit(n) }),
    button('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete', onClick: async () => {
      if (!await confirmDialog(`Delete the secret ${n}? Flows that reference it will receive an empty value.`, { danger: true, confirmLabel: 'Delete' })) return;
      await api.del(`/api/settings/secrets/${encodeURIComponent(n)}`);
      refresh();
    } })))) : h('p', { class: 'muted' }, 'No secrets yet.'));
}

function envVars(env) {
  const rows = Object.entries(env).map(([k, v]) => ({ k, v }));
  const list = h('div', { class: 'stack-sm' });
  const draw = () => fill(list, rows.map((r, i) => h('div', { class: 'row' },
    input(r.k, (v) => (rows[i].k = v), { placeholder: 'NAME', class: 'input mono', style: 'max-width:260px' }),
    input(r.v, (v) => (rows[i].v = v), { placeholder: 'value' }),
    button('', { icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove', onClick: () => { rows.splice(i, 1); draw(); } }))),
  h('div', { class: 'row' }, button('Add variable', { icon: 'plus', size: 'sm', onClick: () => { rows.push({ k: '', v: '' }); draw(); } }),
    button('Save variables', { size: 'sm', kind: 'primary', onClick: async () => {
      try {
        await api.put('/api/settings/env', { vars: Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])) });
        toast('Environment saved', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    } })));
  draw();
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Environment variables'), h('p', {}, 'Plain configuration values for flows: use {{env.NAME}}. Do not store credentials here; use secrets.'))), list);
}

function retention(r) {
  const v = { ...r };
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Run retention'), h('p', {}, 'Older run logs are pruned automatically. 0 disables a limit.'))),
    h('div', { class: 'row', style: { alignItems: 'flex-end' } },
      field('Keep at most (runs)', input(String(v.maxRuns), (x) => (v.maxRuns = Number(x)), { type: 'number', min: 0 })),
      field('Keep for (days)', input(String(v.maxAgeDays), (x) => (v.maxAgeDays = Number(x)), { type: 'number', min: 0 })),
      button('Save', { kind: 'primary', onClick: async () => {
        const res = await api.put('/api/settings/retention', v);
        toast(`Retention saved${res.pruned ? `; pruned ${res.pruned} run(s)` : ''}`, 'success');
      } })));
}

function exportCard() {
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Export'), h('p', {}, 'Download flows, prompts, environment and the shape of collections and tables as JSON. Secrets, credentials and vector data are not included.')),
    button('Export project', { icon: 'download', onClick: async () => downloadFile(`jasmine-export-${new Date().toISOString().slice(0, 10)}.json`, pretty(await api.get('/api/export'))) })));
}

function backupCard(){
  let passphrase='',backup=null;const file=h('input',{type:'file',accept:'.json',onChange:async e=>{try{backup=JSON.parse(await e.target.files[0].text());}catch{toast('Invalid backup file','error');}}});const status=h('div',{class:'small'});
  return card(h('h2',{},'Encrypted backup and restore'),h('p',{class:'muted'},'Includes databases, drafts, uploaded files, credentials and the encryption key. Restore creates a separate workspace so the current one stays available.'),field('Passphrase (12+ characters)',input('',v=>passphrase=v,{type:'password',autocomplete:'new-password'})),h('div',{class:'row'},button('Download encrypted backup',{onClick:async()=>{try{const result=await api.post('/api/backups',{passphrase});downloadFile(`jasmine-backup-${new Date().toISOString().slice(0,10)}.json`,pretty(result));}catch(e){toast(e.message,'error');}}}),file,button('Restore selected backup',{onClick:async()=>{if(!backup)return toast('Select a backup first','error');try{const r=await api.post('/api/backups/restore',{backup,passphrase});status.textContent=`${r.message} ${r.dataDir}`;}catch(e){toast(e.message,'error');}}})),status);
}
