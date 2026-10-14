import { createHash, createHmac } from 'node:crypto';
import { EngineError } from '../errors.ts';
import { xmlToJson } from './xml.ts';

export interface S3Config {
  /** e.g. http://127.0.0.1:9000 for MinIO; https://s3.<region>.amazonaws.com for AWS. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style addressing (MinIO and most self-hosted servers). */
  forcePathStyle?: boolean;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encodeKey = (key: string) =>
  key
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');

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

function sign(
  config: S3Config,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  now = new Date(),
) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(config.sessionToken ? { 'x-amz-security-token': config.sessionToken } : {}),
  };
  const names = Object.keys(all)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const query = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonical = [
    method,
    url.pathname || '/',
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

async function call(
  config: S3Config,
  fetchImpl: typeof fetch,
  method: string,
  url: URL,
  signal: AbortSignal,
  body?: Uint8Array,
  contentType?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const payloadHash = sha256(body ?? '');
  const headers = sign(
    config,
    method,
    url,
    { ...extraHeaders, ...(contentType ? { 'content-type': contentType } : {}) },
    payloadHash,
  );
  let res: Response;
  try {
    res = await fetchImpl(url.href, {
      method,
      headers,
      signal,
      ...(body ? { body: new Uint8Array(body).buffer } : {}),
    });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new EngineError('NETWORK', `S3 endpoint ${url.host} unreachable: ${(e as Error).message}`, {
      retryable: true,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    throw new EngineError(
      res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_HTTP',
      `S3 ${method} returned ${res.status}${code ? ` (${code})` : ''}`,
      { retryable: res.status >= 500 },
    );
  }
  return res;
}

export async function s3Put(
  config: S3Config,
  fetchImpl: typeof fetch,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
  signal: AbortSignal,
) {
  const res = await call(config, fetchImpl, 'PUT', target(config, bucket, key), signal, body, contentType);
  return { bucket, key, etag: res.headers.get('etag')?.replace(/"/g, '') ?? '', size: body.byteLength };
}

export async function s3Get(
  config: S3Config,
  fetchImpl: typeof fetch,
  bucket: string,
  key: string,
  signal: AbortSignal,
) {
  const res = await call(config, fetchImpl, 'GET', target(config, bucket, key), signal);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

export async function s3ListPage(
  config: S3Config,
  fetchImpl: typeof fetch,
  bucket: string,
  prefix: string,
  signal: AbortSignal,
  maxKeys = 1000,
  continuationToken = '',
) {
  const url = target(config, bucket);
  url.searchParams.set('list-type', '2');
  if (prefix) url.searchParams.set('prefix', prefix);
  url.searchParams.set('max-keys', String(Math.min(Math.max(maxKeys, 1), 1000)));
  if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
  const res = await call(config, fetchImpl, 'GET', url, signal);
  const parsed = xmlToJson(await res.text()) as {
    ListBucketResult?: { Contents?: unknown; IsTruncated?: string; NextContinuationToken?: string };
  };
  if (!parsed.ListBucketResult) throw new EngineError('UPSTREAM_HTTP', 'S3 returned no listing result');
  const contents = parsed.ListBucketResult?.Contents;
  const list = (Array.isArray(contents) ? contents : contents ? [contents] : []) as Record<string, string>[];
  const files = list.map((c) => ({
    key: c['Key'] ?? '',
    size: Number(c['Size'] ?? 0),
    lastModified: c['LastModified'] ?? '',
    etag: (c['ETag'] ?? '').replace(/"/g, ''),
  }));
  const isTruncated = String(parsed.ListBucketResult.IsTruncated) === 'true',
    nextContinuationToken = parsed.ListBucketResult.NextContinuationToken;
  if (isTruncated && !nextContinuationToken)
    throw new EngineError('UPSTREAM_HTTP', 'S3 truncated listing has no continuation token');
  return { files, isTruncated, nextContinuationToken };
}

export async function s3List(
  config: S3Config,
  fetchImpl: typeof fetch,
  bucket: string,
  prefix: string,
  signal: AbortSignal,
  maxKeys = 1000,
) {
  return (await s3ListPage(config, fetchImpl, bucket, prefix, signal, maxKeys)).files;
}

export async function s3ListPages(
  config: S3Config,
  fetchImpl: typeof fetch,
  bucket: string,
  prefix: string,
  signal: AbortSignal,
  options: { maxKeys?: number; maxPages?: number; continuationToken?: string } = {},
) {
  const limit = options.maxPages ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new EngineError('BAD_PAYLOAD', 'S3 maxPages must be 1–100');
  let token = options.continuationToken ?? '',
    isTruncated = false;
  const files: Awaited<ReturnType<typeof s3ListPage>>['files'] = [],
    seen = new Set<string>();
  for (let page = 0; page < limit; page++) {
    signal.throwIfAborted();
    if (seen.has(token)) throw new EngineError('UPSTREAM_HTTP', 'S3 repeated a pagination token');
    seen.add(token);
    const result = await s3ListPage(config, fetchImpl, bucket, prefix, signal, options.maxKeys ?? 1000, token);
    files.push(...result.files);
    isTruncated = result.isTruncated;
    token = result.nextContinuationToken ?? '';
    if (!isTruncated) break;
  }
  return { files, isTruncated, ...(isTruncated ? { nextContinuationToken: token } : {}) };
}

export async function s3Delete(
  config: S3Config,
  fetchImpl: typeof fetch,
  bucket: string,
  key: string,
  signal: AbortSignal,
) {
  await call(config, fetchImpl, 'DELETE', target(config, bucket, key), signal);
  return { deleted: true, key };
}

/** Server-side copy. A move deletes the source only after the complete copy result is verified. */
export async function s3Copy(
  config: S3Config,
  fetchImpl: typeof fetch,
  sourceBucket: string,
  sourceKey: string,
  bucket: string,
  key: string,
  signal: AbortSignal,
  move = false,
) {
  if (!sourceKey || !key || (move && sourceBucket === bucket && sourceKey === key))
    throw new EngineError('BAD_PAYLOAD', 'Provide distinct source and destination paths for a move');
  const response = await call(config, fetchImpl, 'PUT', target(config, bucket, key), signal, undefined, undefined, {
    'x-amz-copy-source': `/${encodeURIComponent(sourceBucket)}/${encodeKey(sourceKey)}`,
  });
  const result = xmlToJson(await response.text()) as {
    Error?: { Code?: string };
    CopyObjectResult?: { ETag?: string; LastModified?: string };
  };
  if (result.Error || !result.CopyObjectResult?.ETag)
    throw new EngineError(
      'UPSTREAM_HTTP',
      `S3 copy did not complete${result.Error?.Code ? ` (${result.Error.Code})` : ''}`,
    );
  if (move) await s3Delete(config, fetchImpl, sourceBucket, sourceKey, signal);
  return { bucket, key, sourceBucket, sourceKey, etag: result.CopyObjectResult.ETag.replace(/"/g, ''), moved: move };
}

/** Pre-signed GET URL (query-string SigV4). */
export function s3Presign(
  config: S3Config,
  bucket: string,
  key: string,
  expiresSeconds: number,
  now = new Date(),
): string {
  const url = target(config, bucket, key);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${config.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(Math.min(Math.max(Math.trunc(expiresSeconds), 1), 604_800)));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (config.sessionToken) url.searchParams.set('X-Amz-Security-Token', config.sessionToken);
  const query = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonical = ['GET', url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), 's3'), 'aws4_request');
  url.searchParams.set('X-Amz-Signature', createHmac('sha256', signingKey).update(toSign).digest('hex'));
  return url.href;
}
