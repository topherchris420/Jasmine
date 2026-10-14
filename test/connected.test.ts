import { describe, expect, it } from 'vitest';
import { boundedBytes } from '../src/integrations/oauth.ts';
import { createTestApp, fakeFetch } from './helpers.ts';

const flow = (type: string, values: Record<string, unknown>) => ({ nodes: [
  { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
  { id: 'a', data: { nodeId: type, values } },
  { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{a.output}}' } } },
], edges: [{ source: 't', target: 'a' }, { source: 'a', target: 'r' }] });
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

describe('connected document integrations', () => {
  it('refreshes an expired Google token, stores rotation encrypted, and lists one paginated result', async () => {
    let expired = true;
    const http = fakeFetch((url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') { expect(init.body).toContain('grant_type=refresh_token'); return json({ access_token: 'new-sensitive-token', refresh_token: 'rotated-sensitive-refresh' }); }
      if (expired) { expired = false; return new Response('', { status: 401 }); }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer new-sensitive-token');
      expect(new URL(url).searchParams.get('pageToken')).toBe('page-two');
      return json({ files: [{ id: 'file1', name: 'Notes' }], nextPageToken: 'page-three' });
    });
    const t = await createTestApp({ fetch: http });
    try {
      const credential = t.app.credentials.upsert({ integration: 'google-drive', name: 'drive', data: { accessToken: 'expired-sensitive-token', refreshToken: 'refresh-sensitive-token', clientId: 'test-client' } });
      await t.app.deployments.deploy('f', flow('googleDriveNode', { action: 'list', pageToken: 'page-two', credentials: 'drive' }));
      const result = await t.app.runs.executeWorkflow('f', {});
      expect(result.status).toBe('success');
      expect(result.output).toEqual({ files: [{ id: 'file1', name: 'Notes' }], nextPageToken: 'page-three' });
      expect(t.app.credentials.resolve(credential.id)?.['refreshToken']).toBe('rotated-sensitive-refresh');
      expect(JSON.stringify(t.app.credentials.list())).not.toContain('sensitive');
      expect(JSON.stringify(t.app.db.all('SELECT secret FROM credentials'))).not.toContain('sensitive');
    } finally { await t.close(); }
  });

  it('exports native Google documents as text consumable by an indexing node', async () => {
    const http = fakeFetch((url) => url.includes('/export?') ? new Response('Local workflows make useful tools.', { headers: { 'content-type': 'text/plain' } }) : json({ id: 'doc', name: 'Guide', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc' }));
    const t = await createTestApp({ fetch: http });
    try {
      t.app.credentials.upsert({ integration: 'google-drive', name: 'drive', data: { accessToken: 'test-token' } });
      await t.app.deployments.deploy('f', flow('googleDriveNode', { action: 'download', fileId: 'doc' }));
      const result = await t.app.runs.executeWorkflow('f', {});
      expect(result.output).toMatchObject({ content: 'Local workflows make useful tools.', document_id: 'doc', name: 'Guide.txt' });
      expect(http.calls[1]!.url).toContain('mimeType=text%2Fplain');
    } finally { await t.close(); }
  });

  it('appends Sheets values with an encoded A1 range and refuses unsupported actions', async () => {
    const http = fakeFetch((url, init) => { expect(url).toContain('Sheet%201!A1%3AB2:append'); expect(init.method).toBe('POST'); expect(JSON.parse(String(init.body)).values).toEqual([['name', 'value'], ['Jasmine', 42]]); return json({ updates: { updatedRows: 2 } }); });
    const t = await createTestApp({ fetch: http });
    try {
      t.app.credentials.upsert({ integration: 'google-sheets', name: 'sheet', data: { accessToken: 'test-token' } });
      await t.app.deployments.deploy('f', flow('googleSheetsNode', { action: 'append', spreadsheetId: 'id', range: 'Sheet 1!A1:B2', values: [['name','value'],['Jasmine',42]] }));
      expect((await t.app.runs.executeWorkflow('f', {})).output).toEqual({ updates: { updatedRows: 2 } });
      await t.app.deployments.deploy('f', flow('googleSheetsNode', { action: 'erase-everything', spreadsheetId: 'id', range: 'A1' }));
      expect((await t.app.runs.executeWorkflow('f', {})).error?.code).toBe('BAD_PAYLOAD');
      expect(http.calls).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('downloads Graph files without leaking the bearer token to the preauthenticated URL', async () => {
    const http = fakeFetch((url, init) => {
      if (url.endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://download.example/file' } });
      if (url === 'https://download.example/file') { expect(new Headers(init.headers).get('authorization')).toBeNull(); return new Response('Microsoft document text', { headers: { 'content-type': 'text/plain' } }); }
      return json({ id: 'file', name: 'document.txt' });
    });
    const t = await createTestApp({ fetch: http });
    try {
      t.app.credentials.upsert({ integration: 'sharepoint', name: 'company', data: { accessToken: 'private-token' } });
      await t.app.deployments.deploy('f', flow('sharepointBusinessNode', { action: 'download', driveId: 'drive', itemId: 'file' }));
      expect((await t.app.runs.executeWorkflow('f', {})).output).toMatchObject({ content: 'Microsoft document text' });
      await t.app.deployments.deploy('f', flow('sharepointNode', { action: 'list', driveId: 'drive', nextLink: 'https://attacker.example/v1.0/list' }));
      expect((await t.app.runs.executeWorkflow('f', {})).error?.code).toBe('BAD_PAYLOAD');
      expect(http.calls).toHaveLength(3);
    } finally { await t.close(); }
  });

  it('stops oversized streaming downloads before allocating the entire file', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } }));
    await expect(boundedBytes(response, 1024)).rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
    expect(cancelled).toBe(true);
  });
});
