import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EngineError } from '../errors.ts';

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Reference usable in any file field: `file:<id>`. */
  url: string;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Uploaded files (knowledge sources, test attachments), stored under `<dataDir>/files`. */
export class FileStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  save(bytes: Uint8Array, name: string, mime: string): StoredFile {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new EngineError('BAD_PAYLOAD', `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const id = randomBytes(12).toString('hex');
    const meta: StoredFile = {
      id, name: path.basename(name || 'upload').replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'upload',
      mime: (mime || 'application/octet-stream').split(';')[0]!.trim().slice(0, 100), size: bytes.byteLength, createdAt: new Date().toISOString(), url: `file:${id}`,
    };
    writeFileSync(path.join(this.dir, `${id}.bin`), bytes, { mode: 0o600 });
    writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  info(id: string): StoredFile | undefined {
    if (!ID_RE.test(id)) return undefined;
    const file = path.join(this.dir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as StoredFile;
  }

  async read(id: string): Promise<StoredFile & { bytes: Uint8Array }> {
    const info = this.info(id);
    if (!info) throw new EngineError('NOT_FOUND', `File ${id} not found`);
    return { ...info, bytes: await readFile(path.join(this.dir, `${id}.bin`)) };
  }

  list(): StoredFile[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => this.info(f.slice(0, -5))).filter((x): x is StoredFile => !!x)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  remove(id: string): boolean {
    if (!this.info(id)) return false;
    rmSync(path.join(this.dir, `${id}.bin`), { force: true });
    rmSync(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}
