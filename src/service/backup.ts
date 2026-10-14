import { backup } from 'node:sqlite';
import { scryptSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Jasmine } from '../app.ts';
import { SecretBox } from '../db/secrets.ts';
import { EngineError } from '../errors.ts';

const envelope = z.object({
  format: z.literal('jasmine-backup'),
  version: z.literal(1),
  salt: z.string().length(32),
  encrypted: z.string().min(10).max(200_000_000),
});
/** Consistent SQLite snapshot, files and drafts; encrypted before leaving the process. */
export class BackupService {
  constructor(app: Jasmine) {
    this.app = app;
  }
  private readonly app: Jasmine;
  async export(passphrase: string) {
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1000)
      throw new EngineError('BAD_PAYLOAD', 'Backup passphrase must contain 12–1000 characters');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'jasmine-backup-'));
    try {
      const file = path.join(temp, 'snapshot.db');
      await backup(this.app.db.sqlite, file);
      await chmod(file, 0o600);
      const db = Buffer.from(await readFile(file)).toString('base64');
      const tableFile = path.join(temp, 'tables.db');
      await backup(this.app.tables.snapshotDatabase(), tableFile);
      const tables = Buffer.from(await readFile(tableFile)).toString('base64');
      const files = [];
      let size =
        Buffer.byteLength(db) +
        Buffer.byteLength(tables) +
        Buffer.byteLength(JSON.stringify(this.app.workspace.list()));
      if (size > 100 * 1024 * 1024)
        throw new EngineError('BAD_PAYLOAD', 'Backup exceeds 100 MB; use a filesystem backup');
      for (const f of this.app.files.list()) {
        const bytes = (await this.app.files.read(f.id)).bytes;
        size += bytes.length;
        if (size > 100 * 1024 * 1024)
          throw new EngineError('BAD_PAYLOAD', 'Backup exceeds 100 MB; use a filesystem backup');
        files.push({ meta: f, data: Buffer.from(bytes).toString('base64') });
      }
      const salt = randomBytes(16).toString('hex'),
        box = new SecretBox(scryptSync(passphrase, salt, 32));
      return {
        format: 'jasmine-backup',
        version: 1,
        salt,
        encrypted: box.sealJson({
          database: db,
          tables,
          workspace: { schema: 1, flows: this.app.workspace.list() },
          files,
          secretKey: this.app.box.exportKeyForBackup(),
          createdAt: new Date().toISOString(),
        }),
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async restore(input: unknown, passphrase: string) {
    const parsed = envelope.safeParse(input);
    if (!parsed.success || typeof passphrase !== 'string' || passphrase.length > 1000)
      throw new EngineError('BAD_PAYLOAD', 'Invalid backup or passphrase');
    let value: {
      database: string;
      tables: string;
      workspace: unknown;
      files: {
        meta: { id: string; name: string; mime: string; size: number; createdAt: string; url: string };
        data: string;
      }[];
      secretKey: string;
    };
    try {
      value = new SecretBox(scryptSync(passphrase, parsed.data.salt, 32)).openJson(parsed.data.encrypted);
    } catch {
      throw new EngineError('BAD_PAYLOAD', 'Backup cannot be decrypted; check the passphrase');
    }
    if (!value.database || !Array.isArray(value.files) || !/^[a-f0-9]{64}$/.test(value.secretKey))
      throw new EngineError('BAD_PAYLOAD', 'Invalid decrypted backup');
    const directory = path.join(this.app.config.dataDir, 'restores', `workspace-${randomUUID()}`);
    await mkdir(path.join(directory, 'files'), { recursive: true });
    try {
      await writeFile(path.join(directory, 'jasmine.db'), Buffer.from(value.database, 'base64'), { mode: 0o600 });
      await writeFile(path.join(directory, 'tables.db'), Buffer.from(value.tables, 'base64'), { mode: 0o600 });
      await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(value.workspace), { mode: 0o600 });
      await writeFile(path.join(directory, 'secret.key'), value.secretKey, { mode: 0o600 });
      for (const f of value.files) {
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(f.meta.id)) throw new EngineError('BAD_PAYLOAD', 'Invalid backup file id');
        await writeFile(path.join(directory, 'files', `${f.meta.id}.bin`), Buffer.from(f.data, 'base64'), {
          mode: 0o600,
        });
        await writeFile(path.join(directory, 'files', `${f.meta.id}.json`), JSON.stringify(f.meta), { mode: 0o600 });
      }
      // Validate the restored data before handing it off, without running flows or probing models.
      const { Jasmine } = await import('../app.ts');
      const restored = await Jasmine.create({ dataDir: directory, probeModels: false, scheduler: false, seed: false });
      await restored.close();
      return {
        dataDir: directory,
        restartRequired: true,
        message: 'Restored into a separate workspace. Start Jasmine with JASMINE_DATA_DIR set to dataDir.',
      };
    } catch (e) {
      await rm(directory, { recursive: true, force: true });
      throw e;
    }
  }
}
