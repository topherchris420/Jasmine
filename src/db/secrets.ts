import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts credentials at rest with AES-256-GCM. The key comes from `JASMINE_SECRET_KEY`
 * (64 hex chars or base64 of 32 bytes) or from `<dataDir>/secret.key`, created with mode 0600.
 * This protects a copied database file; it is not a defence against someone who can read the key.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Secret key must be 32 bytes');
    this.key = key;
  }

  static fromEnvOrFile(dataDir: string, envValue: string | undefined): SecretBox {
    if (envValue) return new SecretBox(decodeKey(envValue));
    const file = path.join(dataDir, 'secret.key');
    if (existsSync(file)) return new SecretBox(decodeKey(readFileSync(file, 'utf8').trim()));
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    return new SecretBox(key);
  }

  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(32));
  }

  exportKeyForBackup():string { return this.key.toString('hex'); }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
  }

  open(sealed: string): string {
    if (!sealed.startsWith(PREFIX)) return sealed;
    const [iv, tag, body] = sealed.slice(PREFIX.length).split(':');
    if (!iv || !tag || body === undefined) throw new Error('Malformed sealed secret');
    const nonce = Buffer.from(iv, 'base64');
    const authTag = Buffer.from(tag, 'base64');
    // Only full 128-bit tags: GCM would otherwise accept a truncated tag, making forgeries far cheaper.
    if (nonce.length !== IV_BYTES || authTag.length !== TAG_BYTES) throw new Error('Malformed sealed secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  }

  sealJson(value: unknown): string {
    return this.seal(JSON.stringify(value));
  }

  openJson<T>(sealed: string): T {
    return JSON.parse(this.open(sealed)) as T;
  }
}

function decodeKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('JASMINE_SECRET_KEY must be 32 bytes (64 hex characters or base64)');
  return key;
}
