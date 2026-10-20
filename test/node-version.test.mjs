import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Runs the check as npm would, optionally under a reported Node version other than this one.
const check = version => spawnSync(process.execPath, [
  ...(version ? ['--import', `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${version}"})`] : []),
  'scripts/check-node.mjs',
], { encoding: 'utf8' });

describe('Node version check', () => {
  it('runs before the server starts and stops an outdated Node with a plain explanation', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(scripts.prestart).toBe('node scripts/check-node.mjs');
    expect(scripts.preserve).toBe('node scripts/check-node.mjs');
    const old = check('20.11.1');
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('Jasmine needs Node.js 24 or newer, and this is Node.js 20.11.1.');
    expect(old.stderr).toContain('https://nodejs.org');
    expect(check().status).toBe(0);
    expect(check('24.0.0').status).toBe(0);
  });
});
