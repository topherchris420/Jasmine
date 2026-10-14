import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/service/workspace.ts';
import { studioArticleSummariser } from './helpers.ts';

describe('local workspace persistence', () => {
  it('restores drafts and the last deployed definition independently', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jasmine-workspace-'));
    try {
      const store = new WorkspaceStore(directory); await store.load();
      const definition = studioArticleSummariser();
      await store.save('article', 'Article', definition, 0);
      await store.markDeployed('article', definition, 'v_first');
      definition.meta.name = 'Edited draft';
      await store.save('article', 'Edited draft', definition, 1);
      const restored = new WorkspaceStore(directory); await restored.load();
      expect(restored.get('article')).toMatchObject({ name: 'Edited draft', revision: 2, deployedVersion: 'v_first', deployedDefinition: { meta: { name: 'Article Summariser' } } });
      expect(JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8')).schema).toBe(1);
      const copy = restored.get('article')!; copy.name = 'Mutated copy';
      expect(restored.get('article')?.name).toBe('Edited draft');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('serializes competing revisions and rejects stale edits without losing the winner', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jasmine-workspace-'));
    try {
      const store = new WorkspaceStore(directory); await store.load();
      const definition = studioArticleSummariser(); await store.save('article', 'Article', definition, 0);
      const results = await Promise.allSettled([store.save('article', 'Winner', definition, 1), store.save('article', 'Stale', definition, 1)]);
      expect(results[0]?.status).toBe('fulfilled');
      expect(results[1]?.status).toBe('rejected');
      expect(store.get('article')).toMatchObject({ name: 'Winner', revision: 2 });
      const restored = new WorkspaceStore(directory); await restored.load();
      expect(restored.get('article')).toMatchObject({ name: 'Winner', revision: 2 });
      expect(() => store.save('../outside', 'Bad', definition)).toThrow('Invalid workflow ID');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});


describe('workspace failure recovery', () => {
  it('captures save and deployment inputs before queued writes begin', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jasmine-workspace-'));
    try {
      const store = new WorkspaceStore(directory); await store.load();
      const definition = studioArticleSummariser();
      const saving = store.save('article', 'Article', definition, 0);
      definition.meta.name = 'Mutated after save';
      await saving;
      expect(store.get('article')?.definition).toMatchObject({ meta: { name: 'Article Summariser' } });
      const deploying = store.markDeployed('article', definition, 'v_first');
      definition.meta.name = 'Mutated after deployment';
      await deploying;
      const restored = new WorkspaceStore(directory); await restored.load();
      expect(restored.get('article')?.deployedDefinition).toMatchObject({ meta: { name: 'Mutated after save' } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps committed state and removes temporary files after a failed rename, then accepts a retry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jasmine-workspace-'));
    try {
      const store = new WorkspaceStore(directory); await store.load();
      const definition = studioArticleSummariser();
      await store.save('article', 'Original', definition, 0);
      const snapshot = path.join(directory, 'workspace.json');
      await rename(snapshot, path.join(directory, 'backup.json'));
      await mkdir(snapshot);
      await expect(store.save('article', 'Failed write', definition, 1)).rejects.toThrow();
      expect(store.get('article')).toMatchObject({ name: 'Original', revision: 1 });
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      await rm(snapshot, { recursive: true });
      await rename(path.join(directory, 'backup.json'), snapshot);
      await store.save('article', 'Retry', definition, 1);
      const restored = new WorkspaceStore(directory); await restored.load();
      expect(restored.get('article')).toMatchObject({ name: 'Retry', revision: 2 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects corrupt and duplicate snapshots without partially replacing loaded state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jasmine-workspace-'));
    try {
      const store = new WorkspaceStore(directory); await store.load();
      const original = await store.save('article', 'Original', studioArticleSummariser(), 0);
      const replacement = { ...original, name: 'Replacement' };
      for (const flows of [[replacement, null], [replacement, replacement]]) {
        await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({ schema: 1, flows }));
        await expect(store.load()).rejects.toThrow();
        expect(store.list()).toEqual([original]);
      }
      await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({ schema: 1, flows: [] }));
      await store.load();
      expect(store.list()).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
