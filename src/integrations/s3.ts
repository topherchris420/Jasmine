import { createHash, createHmac } from 'node:crypto';
import { EngineError } from '../errors.ts';
import { xmlToJson } from './xml.ts';

export interface S3Config {
  /** e.g. http://127.0.0.1:9000 for MinIO; https://s3.<region>.amazonaws.com for AWS. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (MinIO and most self-hosted servers). */
  forcePathStyle?: boolean;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encodeKey = (key: string) => key.split('/').map((p) => encodeURIComponent(p)).join('/');

function target(config: S3Config, bucket: string, key = ''): URL {
  const base = new URL(config.endpoint);
  if (config.forcePathStyle !== false) {
    base.pathname = `/${bucket}${key ? `/${encodeKey(key)}` : ''}`;
  } else {
    base.host = `${bucket}.${base.host}`;
    base.pathname = key ? `/${encodeKey(key)}` : '/';
  }
  return base;
}

function sign(config: S3Config, method: string, url: URL, headers: Record<string, string>, payloadHash: string, now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = { ...headers, host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const query = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [method, url.pathname || '/', query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

async function call(config: S3Config, fetchImpl: typeof fetch, method: string, url: URL, signal: AbortSignal, body?: Uint8Array, contentType?: string): Promise<Response> {
  const payloadHash = sha256(body ?? '');
  const headers = sign(config, method, url, contentType ? { 'content-type': contentType } : {}, payloadHash);
  let res: Response;
  try {
    res = await fetchImpl(url.href, { method, headers, signal, ...(body ? { body } : {}) });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new EngineError('NETWORK', `S3 endpoint ${url.host} unreachable: ${(e as Error).message}`, { retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    throw new EngineError(res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_HTTP', `S3 ${method} returned ${res.status}${code ? ` (${code})` : ''}`, { retryable: res.status >= 500 });
  }
  return res;
}

export async function s3Put(config: S3Config, fetchImpl: typeof fetch, bucket: string, key: string, body: Uint8Array, contentType: string, signal: AbortSignal) {
  const res = await call(config, fetchImpl, 'PUT', target(config, bucket, key), signal, body, contentType);
  return { bucket, key, etag: res.headers.get('etag')?.replace(/"/g, '') ?? '', size: body.byteLength };
}

export async function s3Get(config: S3Config, fetchImpl: typeof fetch, bucket: string, key: string, signal: AbortSignal) {
  const res = await call(config, fetchImpl, 'GET', target(config, bucket, key), signal);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

export async function s3List(config: S3Config, fetchImpl: typeof fetch, bucket: string, prefix: string, signal: AbortSignal, maxKeys = 1000) {
  const url = target(config, bucket);
  url.searchParams.set('list-type', '2');
  if (prefix) url.searchParams.set('prefix', prefix);
  url.searchParams.set('max-keys', String(Math.min(Math.max(maxKeys, 1), 1000)));
  const res = await call(config, fetchImpl, 'GET', url, signal);
  const parsed = xmlToJson(await res.text()) as { ListBucketResult?: { Contents?: unknown } };
  const contents = parsed.ListBucketResult?.Contents;
  const list = (Array.isArray(contents) ? contents : contents ? [contents] : []) as Record<string, string>[];
  return list.map((c) => ({ key: c['Key'] ?? '', size: Number(c['Size'] ?? 0), lastModified: c['LastModified'] ?? '', etag: (c['ETag'] ?? '').replace(/"/g, '') }));
}

export async function s3Delete(config: S3Config, fetchImpl: typeof fetch, bucket: string, key: string, signal: AbortSignal) {
  await call(config, fetchImpl, 'DELETE', target(config, bucket, key), signal);
  return { deleted: true, key };
}

/** Pre-signed GET URL (query-string SigV4). */
export function s3Presign(config: S3Config, bucket: string, key: string, expiresSeconds: number, now = new Date()): string {
  const url = target(config, bucket, key);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${config.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(Math.min(Math.max(Math.trunc(expiresSeconds), 1), 604_800)));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  const query = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = ['GET', url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), 's3'), 'aws4_request');
  url.searchParams.set('X-Amz-Signature', createHmac('sha256', signingKey).update(toSign).digest('hex'));
  return url.href;
}
