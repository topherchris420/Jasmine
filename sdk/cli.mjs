#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JasmineClient } from './jasmine.mjs';

const args = process.argv.slice(2),
  flags = {};
for (let i = 0; i < args.length; i++)
  if (args[i].startsWith('--')) {
    const key = args.splice(i, 1)[0].slice(2);
    flags[key] = args[i] && !args[i].startsWith('--') ? args.splice(i, 1)[0] : true;
    i--;
  }
const [group, action, id] = args;
const profileFile = process.env.JASMINE_CLI_CONFIG || path.join(os.homedir(), '.config', 'jasmine', 'client.json');
const profile = await readFile(profileFile, 'utf8')
  .then(JSON.parse)
  .catch(() => ({}));
const endpoint = flags.endpoint || process.env.JASMINE_ENDPOINT || profile.endpoint || 'http://127.0.0.1:8787';
const client = new JasmineClient({
  endpoint,
  apiKey: process.env.JASMINE_API_KEY || profile.apiKey,
  projectId: process.env.JASMINE_PROJECT_ID || profile.projectId,
});
const body = async () =>
  flags.file
    ? JSON.parse(await readFile(String(flags.file), 'utf8'))
    : flags.json
      ? JSON.parse(String(flags.json))
      : {};
const output = (value) => console.log(JSON.stringify(value, null, 2));
const eid = () => {
  if (!id) throw new Error('Supply a resource id');
  return encodeURIComponent(id);
};
try {
  if (!group || group === 'help' || flags.help) {
    console.log(
      'Jasmine CLI\nconfigure --endpoint URL (key from JASMINE_API_KEY)\nstatus | project get\nflows list|get|create|rename|delete|validate|deploy|run ID --file JSON\ndeployments list|get|rollback ID\ncontexts list|create|get|delete NAME --file JSON\nmodels list|add --file JSON\nintegrations list | credentials add --file JSON\nlogs list|get ID\nbackup export --output FILE (passphrase from JASMINE_BACKUP_PASSPHRASE)\nbackup restore --file FILE\nOptional --endpoint URL and --json JSON.',
    );
  } else if (group === 'configure') {
    await mkdir(path.dirname(profileFile), { recursive: true });
    await writeFile(
      profileFile,
      JSON.stringify({ endpoint, apiKey: process.env.JASMINE_API_KEY, projectId: process.env.JASMINE_PROJECT_ID }),
      { mode: 0o600 },
    );
    output({ configured: true, endpoint });
  } else if (group === 'status') output(await client.request('/api/status'));
  else if (group === 'project' && action === 'get') output(await client.request('/api/settings'));
  else if (group === 'flows') {
    if (action === 'list') output(await client.request('/api/flows'));
    else if (action === 'get') output(await client.request(`/api/flows/${eid()}`));
    else if (action === 'create') output(await client.request('/api/flows', { method: 'POST', body: await body() }));
    else if (action === 'delete') output(await client.request(`/api/flows/${eid()}`, { method: 'DELETE' }));
    else if (action === 'rename') {
      const f = await client.request(`/api/flows/${eid()}`);
      output(
        await client.request(`/api/flows/${eid()}`, {
          method: 'PUT',
          body: { name: flags.name, definition: f.definition, expectedRevision: f.revision },
        }),
      );
    } else if (action === 'validate' || action === 'deploy')
      output(await client.request(`/api/flows/${eid()}/${action}`, { method: 'POST', body: await body() }));
    else if (action === 'run')
      output(
        await client.executeFlow(id, await body(), {
          mode: flags.async ? 'async' : 'realtime',
          idempotencyKey: flags['idempotency-key'],
        }),
      );
    else throw new Error('Unknown flows action');
  } else if (group === 'deployments') {
    if (action === 'list') output((await client.request('/api/flows')).filter((f) => f.deployedVersion));
    else if (action === 'get') output(await client.request(`/api/flows/${eid()}/versions`));
    else if (action === 'rollback')
      output(
        await client.request(`/api/flows/${eid()}/rollback`, {
          method: 'POST',
          body: flags.version ? { toVersion: flags.version } : {},
        }),
      );
    else throw new Error('Unknown deployment action');
  } else if (group === 'contexts') {
    if (action === 'list') output(await client.request('/api/collections'));
    else if (action === 'create')
      output(await client.request('/api/collections', { method: 'POST', body: await body() }));
    else if (action === 'get' || action === 'delete')
      output(await client.request(`/api/collections/${eid()}`, { method: action === 'delete' ? 'DELETE' : 'GET' }));
    else throw new Error('Unknown context action');
  } else if (group === 'models') {
    if (action === 'list') output(await client.request('/api/models'));
    else if (action === 'add')
      output(await client.request('/api/models/connections', { method: 'POST', body: await body() }));
    else throw new Error('Unknown model action');
  } else if (group === 'integrations' && action === 'list') output(await client.request('/api/integrations'));
  else if (group === 'credentials' && action === 'add')
    output(await client.request('/api/credentials', { method: 'POST', body: await body() }));
  else if (group === 'logs') output(await client.request(action === 'get' ? `/api/runs/${eid()}` : '/api/runs'));
  else if (group === 'backup') {
    const passphrase = process.env.JASMINE_BACKUP_PASSPHRASE;
    if (!passphrase) throw new Error('Set JASMINE_BACKUP_PASSPHRASE');
    if (action === 'export') {
      const backup = await client.request('/api/backups', { method: 'POST', body: { passphrase } });
      if (!flags.output) throw new Error('Supply --output FILE');
      await writeFile(String(flags.output), JSON.stringify(backup), { mode: 0o600 });
      output({ saved: flags.output });
    } else if (action === 'restore')
      output(
        await client.request('/api/backups/restore', { method: 'POST', body: { backup: await body(), passphrase } }),
      );
    else throw new Error('Unknown backup action');
  } else throw new Error('Unknown command. Run jasmine help.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
