import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr || `Cannot check ${file}\n`); process.exitCode = 1; }
    }
  }
}
await scan('public');
await scan('sdk');
if (!process.exitCode) console.log('Studio, widget, and SDK scripts passed syntax checks.');
