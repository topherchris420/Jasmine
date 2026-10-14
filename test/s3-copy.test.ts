import { describe, expect, it } from 'vitest';
import { s3Copy } from '../src/integrations/s3.ts';
import { fakeFetch } from './helpers.ts';
const config = { endpoint: 'http://127.0.0.1:9000', region: 'local', accessKeyId: 'key', secretAccessKey: 'secret' };
describe('S3 copy and move', () => {
  it('signs the encoded copy source and deletes only after success', async () => {
    const http = fakeFetch((_url, init) =>
      init.method === 'PUT'
        ? new Response('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>')
        : new Response(null, { status: 204 }),
    );
    expect(
      (await s3Copy(config, http, 'source', 'a b/file.txt', 'destination', 'new.txt', AbortSignal.timeout(1000), true))
        .moved,
    ).toBe(true);
    expect(new Headers(http.calls[0]!.init.headers).get('x-amz-copy-source')).toBe('/source/a%20b/file.txt');
    expect(new Headers(http.calls[0]!.init.headers).get('authorization')).toContain('x-amz-copy-source');
    expect(http.calls.map((c) => c.init.method)).toEqual(['PUT', 'DELETE']);
  });
  it('retains the source on an embedded HTTP 200 copy error', async () => {
    const http = fakeFetch(() => new Response('<Error><Code>InternalError</Code></Error>'));
    await expect(
      s3Copy(config, http, 'source', 'file', 'destination', 'new', AbortSignal.timeout(1000), true),
    ).rejects.toMatchObject({ code: 'UPSTREAM_HTTP' });
    expect(http.calls).toHaveLength(1);
    await expect(
      s3Copy(config, http, 'source', 'file', 'source', 'file', AbortSignal.timeout(1000), true),
    ).rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
  });
});
