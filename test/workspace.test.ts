import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
