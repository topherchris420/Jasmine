import { describe, expect, it } from 'vitest';
import { s3ListPages, s3Presign, s3Put } from '../src/integrations/s3.ts';
import { fakeFetch } from './helpers.ts';
const config = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'local',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  sessionToken: 'temporary-token',
};
describe('S3 pagination and temporary credentials', () => {
  it('follows encoded continuation tokens, preserving bounded pagination metadata', async () => {
    const http = fakeFetch((url) =>
      new URL(url).searchParams.has('continuation-token')
        ? new Response(
            '<ListBucketResult><Contents><Key>two</Key><Size>2</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
          )
        : new Response(
            '<ListBucketResult><Contents><Key>one</Key><Size>1</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>a+/b=</NextContinuationToken></ListBucketResult>',
          ),
    );
    const single = await s3ListPages(config, http, 'bucket', '', AbortSignal.timeout(1000));
    expect(single.isTruncated).toBe(true);
    expect(single.nextContinuationToken).toBe('a+/b=');
    const all = await s3ListPages(config, http, 'bucket', '', AbortSignal.timeout(1000), { maxPages: 2 });
    expect(all.files.map((f) => f.key)).toEqual(['one', 'two']);
    expect(all.isTruncated).toBe(false);
    expect(new URL(http.calls.at(-1)!.url).searchParams.get('continuation-token')).toBe('a+/b=');
  });
  it('rejects repeated tokens and invalid page limits rather than looping indefinitely', async () => {
    const http = fakeFetch(
      () =>
        new Response(
          '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>',
        ),
    );
    await expect(
      s3ListPages(config, http, 'bucket', '', AbortSignal.timeout(1000), { maxPages: 5 }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_HTTP' });
    expect(http.calls).toHaveLength(2);
    await expect(
      s3ListPages(config, http, 'bucket', '', AbortSignal.timeout(1000), { maxPages: 0 }),
    ).rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
  });
  it('signs temporary session credentials for requests and shared links', async () => {
    const http = fakeFetch(() => new Response(null, { headers: { etag: '"stored"' } }));
    await s3Put(config, http, 'bucket', 'key', Buffer.from('text'), 'text/plain', AbortSignal.timeout(1000));
    const headers = new Headers(http.calls[0]!.init.headers);
    expect(headers.get('x-amz-security-token')).toBe('temporary-token');
    expect(headers.get('authorization')).toContain('x-amz-security-token');
    expect(new URL(s3Presign(config, 'bucket', 'key', 60)).searchParams.get('X-Amz-Security-Token')).toBe(
      'temporary-token',
    );
  });
});
