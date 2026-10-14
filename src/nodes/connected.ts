import { EngineError } from '../errors.ts';
import { oauthFetch, boundedBytes, type OAuthOptions } from '../integrations/oauth.ts';
import { extractDocument } from '../vector/extract.ts';
import { f, jsonField, required, str, val } from './common.ts';
import type { FieldSpec, NodeContext, NodeHandler, NodeSpec } from './types.ts';

const enc = encodeURIComponent;
const need = (ctx: NodeContext, key: string) => {
  const value = str(val(ctx, key)).trim();
  if (!value) throw new EngineError('BAD_PAYLOAD', `${key} is required`);
  return value;
};
const oauthFields: NonNullable<NodeSpec['credentialFields']> = [
  { key: 'accessToken', label: 'OAuth access token', secret: true },
  { key: 'refreshToken', label: 'Refresh token (optional)', secret: true },
  { key: 'clientId', label: 'OAuth client id (for refresh)' },
  { key: 'clientSecret', label: 'OAuth client secret (if required)', secret: true },
];

function connection(ctx: NodeContext, integration: string, provider: OAuthOptions['provider']): OAuthOptions {
  const raw = val(ctx, 'credentials', val(ctx, 'credential', undefined));
  const ref = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? str((raw as Record<string, unknown>)['id'] ?? (raw as Record<string, unknown>)['credentialId'] ?? (raw as Record<string, unknown>)['name']) : undefined;
  const credentials = ctx.services.credentials?.resolve(ref || undefined, integration);
  if (!credentials) throw new EngineError('BAD_PAYLOAD', `Configure a ${integration} credential under Integrations`);
  return { provider, credentials, fetch: ctx.services.fetch, signal: ctx.signal, saveTokens: (tokens) => ctx.services.credentials?.updateTokens?.(ref || undefined, integration, tokens) };
}
const asJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiJson = async (oauth: OAuthOptions, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
  const response = await oauthFetch(url, init, oauth);
  if (response.status === 204) return { deleted: true };
  if (!response.ok) { await response.body?.cancel(); throw new EngineError('UPSTREAM_HTTP', 'Unexpected API redirect'); }
  return JSON.parse(new TextDecoder().decode(await boundedBytes(response, 5 * 1024 * 1024))) as Record<string, unknown>;
};

async function fileOutput(response: Response, name: string, metadata: Record<string, unknown>) {
  const mime = response.headers.get('content-type')?.split(';')[0] ?? 'text/plain';
  const bytes = await boundedBytes(response);
  const doc = extractDocument(bytes, { filename: name, mime });
  return { metadata, name, mime, bytes: bytes.length, content: doc.pages.join('\n\n'), pages: doc.pages, ...(doc.rows ? { rows: doc.rows } : {}), document_id: String(metadata['id'] ?? ''), document_name: name, document_url: String(metadata['webViewLink'] ?? metadata['webUrl'] ?? '') };
}

function connected(type: string, label: string, integration: string, fields: FieldSpec[], defaults: Record<string, unknown>, run: NodeHandler['run'], provider: OAuthOptions['provider'], hidden = false): NodeHandler {
  return {
    type, kind: 'action',
    spec: { label, category: 'app', icon: 'folder', integration, hidden,
      description: `${label} actions using your OAuth token. Account access is explicit; AI inference remains on your local model connections.`,
      credentialFields: provider === 'microsoft' ? [...oauthFields, { key: 'tenantId', label: 'Tenant id (default: common)' }] : oauthFields,
      fields: [f.credential(integration), ...fields],
      outputs: [{ path: 'content', type: 'string' }, { path: 'files', type: 'array' }, { path: 'values', type: 'array' }, { path: 'id', type: 'string' }, { path: 'nextPageToken', type: 'string' }, { path: 'nextLink', type: 'string' }, { path: 'metadata', type: 'object' }],
      defaults: () => ({ nodeName: label, ...structuredClone(defaults) }),
    },
    validate: (node) => required(node, 'action'),
    sideEffect: (node) => !['list', 'get', 'download', 'export', 'read', 'drives'].includes(str(node.values['action'])),
    // Writes are not automatically repeated after an ambiguous network failure.
    idempotent: () => false,
    run,
  };
}

const driveFields = [
  f.select('action', 'Action', ['list', 'get', 'download', 'export', 'upload', 'createFolder', 'delete']),
  f.text('fileId', 'File id', { showIf: { key: 'action', equals: ['get', 'download', 'export', 'delete'] } }),
  f.text('folderId', 'Parent folder id', { advanced: true }), f.text('query', 'Drive query', { advanced: true }),
  f.text('pageToken', 'Next page token', { advanced: true }), f.num('pageSize', 'Page size', { advanced: true }),
  f.text('name', 'File or folder name', { showIf: { key: 'action', equals: ['upload', 'createFolder'] } }),
  f.area('content', 'Text to upload', { showIf: { key: 'action', equals: ['upload'] } }),
  f.text('mimeType', 'Content or export MIME type', { advanced: true }),
];
const googleDrive = connected('googleDriveNode', 'Google Drive', 'google-drive', driveFields, { action: 'list', pageSize: 100 }, async (ctx) => {
  const oauth = connection(ctx, 'google-drive', 'google');
  const action = need(ctx, 'action'); const base = 'https://www.googleapis.com/drive/v3/files';
  if (action === 'list') {
    const params = new URLSearchParams({ pageSize: String(Math.min(1000, Math.max(1, Number(val(ctx, 'pageSize', 100)) || 100))), fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    const folder = str(val(ctx, 'folderId', '')); const query = str(val(ctx, 'query', ''));
    params.set('q', ["trashed = false", folder ? `'${folder.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents` : '', query].filter(Boolean).map((x) => `(${x})`).join(' and '));
    if (val(ctx, 'pageToken')) params.set('pageToken', str(val(ctx, 'pageToken')));
    return { output: await apiJson(oauth, `${base}?${params}`) };
  }
  if (action === 'upload' || action === 'createFolder') {
    const name = need(ctx, 'name'); const folder = str(val(ctx, 'folderId', ''));
    const metadata = { name, ...(folder ? { parents: [folder] } : {}), ...(action === 'createFolder' ? { mimeType: 'application/vnd.google-apps.folder' } : {}) };
    if (action === 'createFolder') return { output: await apiJson(oauth, `${base}?supportsAllDrives=true`, asJson(metadata)) };
    const content = str(val(ctx, 'content', '')); if (content.length > 1_000_000) throw new EngineError('BAD_PAYLOAD', 'Text upload exceeds 1 million characters');
    const boundary = `jasmine_${ctx.runId.replace(/[^a-z0-9]/gi, '')}`;
    if (content.includes(boundary)) throw new EngineError('BAD_PAYLOAD', 'Upload contains the multipart boundary');
    const mime = str(val(ctx, 'mimeType', 'text/plain'));
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) throw new EngineError('BAD_PAYLOAD', 'Invalid MIME type');
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return { output: await apiJson(oauth, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body }) };
  }
  if (!['get', 'download', 'export', 'delete'].includes(action)) throw new EngineError('BAD_PAYLOAD', `Unknown Google Drive action: ${action}`);
  const file = `${base}/${enc(need(ctx, 'fileId'))}`;
  if (action === 'delete') return { output: await apiJson(oauth, `${file}?supportsAllDrives=true`, { method: 'DELETE' }) };
  const metadata = await apiJson(oauth, `${file}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`);
  if (action === 'get') return { output: metadata };
  const native = str(metadata['mimeType']).startsWith('application/vnd.google-apps.');
  const mime = str(val(ctx, 'mimeType', metadata['mimeType'] === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : 'text/plain'));
  const url = action === 'export' || native ? `${file}/export?${new URLSearchParams({ mimeType: mime })}` : `${file}?alt=media&supportsAllDrives=true`;
  const response = await oauthFetch(url, {}, oauth);
  if (!response.ok) { await response.body?.cancel(); throw new EngineError('UPSTREAM_HTTP', 'Unexpected download redirect'); }
  return { output: await fileOutput(response, native ? `${str(metadata['name'])}.${mime === 'text/csv' ? 'csv' : mime === 'application/pdf' ? 'pdf' : 'txt'}` : str(metadata['name']), metadata) };
}, 'google');

const sheets = connected('googleSheetsNode', 'Google Sheets', 'google-sheets', [
  f.select('action', 'Action', ['read', 'append', 'update', 'clear']), f.text('spreadsheetId', 'Spreadsheet id', { required: true }),
  f.text('range', 'A1 range', { required: true }), f.json('values', 'Rows of values', { showIf: { key: 'action', equals: ['append', 'update'] } }),
  f.select('valueInputOption', 'Input interpretation', ['RAW', 'USER_ENTERED'], { advanced: true }),
], { action: 'read', range: 'Sheet1!A1:Z100', valueInputOption: 'RAW', values: '[]' }, async (ctx) => {
  const oauth = connection(ctx, 'google-sheets', 'google'); const action = need(ctx, 'action');
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${enc(need(ctx, 'spreadsheetId'))}/values/${enc(need(ctx, 'range'))}`;
  if (action === 'read') return { output: await apiJson(oauth, base) };
  if (action === 'clear') return { output: await apiJson(oauth, `${base}:clear`, asJson({})) };
  if (action !== 'append' && action !== 'update') throw new EngineError('BAD_PAYLOAD', `Unknown Google Sheets action: ${action}`);
  const values = jsonField(ctx, 'values', []);
  if (!Array.isArray(values) || values.length > 10000 || values.some((row) => !Array.isArray(row) || row.some((cell) => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)))) throw new EngineError('BAD_PAYLOAD', 'values must be an array of rows containing scalar cells');
  const option = str(val(ctx, 'valueInputOption', 'RAW'));
  if (!['RAW', 'USER_ENTERED'].includes(option)) throw new EngineError('BAD_PAYLOAD', 'valueInputOption must be RAW or USER_ENTERED');
  return { output: await apiJson(oauth, `${base}${action === 'append' ? ':append' : ''}?${new URLSearchParams({ valueInputOption: option })}`, { ...asJson({ values, majorDimension: 'ROWS' }), method: action === 'append' ? 'POST' : 'PUT' }) };
}, 'google');

function graphDrive(type: string, label: string, integration: string, hidden = false) {
  return connected(type, label, integration, [
    f.select('action', 'Action', ['list', 'drives', 'get', 'download', 'upload', 'createFolder', 'delete']),
    f.text('driveId', 'Drive id (optional for OneDrive)'), f.text('siteId', 'SharePoint site id', { advanced: true }),
    f.text('itemId', 'File or folder id'), f.text('name', 'File or folder name'), f.area('content', 'Text to upload'),
    f.text('nextLink', 'Next page URL', { advanced: true }),
  ], { action: 'list', itemId: 'root' }, async (ctx) => {
    const oauth = connection(ctx, integration, 'microsoft'); const action = need(ctx, 'action');
    const site = str(val(ctx, 'siteId', '')); const drive = str(val(ctx, 'driveId', ''));
    const base = 'https://graph.microsoft.com/v1.0';
    if (integration === 'sharepoint' && !site && !drive) throw new EngineError('BAD_PAYLOAD', 'SharePoint requires siteId or driveId');
    const root = drive ? `${base}/drives/${enc(drive)}` : site ? `${base}/sites/${enc(site)}/drive` : `${base}/me/drive`;
    const id = str(val(ctx, 'itemId', 'root')); const item = id === 'root' ? `${root}/root` : `${root}/items/${enc(id)}`;
    if (action === 'drives') return { output: await apiJson(oauth, site ? `${base}/sites/${enc(site)}/drives` : `${base}/me/drives`) };
    if (action === 'list') {
      const next = str(val(ctx, 'nextLink', '')); let url = `${item}/children?$top=100`;
      if (next) { const parsed = new URL(next); if (parsed.origin !== 'https://graph.microsoft.com' || !parsed.pathname.startsWith('/v1.0/') || parsed.username || parsed.password) throw new EngineError('BAD_PAYLOAD', 'nextLink must be a Microsoft Graph v1.0 URL'); url = parsed.href; }
      const data = await apiJson(oauth, url); return { output: { files: data['value'] ?? [], nextLink: data['@odata.nextLink'] ?? null } };
    }
    if (action === 'createFolder') return { output: await apiJson(oauth, `${item}/children`, asJson({ name: need(ctx, 'name'), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })) };
    if (action === 'upload') {
      const content = str(val(ctx, 'content', '')); if (content.length > 1_000_000) throw new EngineError('BAD_PAYLOAD', 'Text upload exceeds 1 million characters');
      return { output: await apiJson(oauth, `${item}:/${enc(need(ctx, 'name'))}:/content`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content }) };
    }
    if (action === 'delete') { if (id === 'root') throw new EngineError('BAD_PAYLOAD', 'Cannot delete the drive root'); return { output: await apiJson(oauth, item, { method: 'DELETE' }) }; }
    if (action !== 'get' && action !== 'download') throw new EngineError('BAD_PAYLOAD', `Unknown ${label} action: ${action}`);
    const metadata = await apiJson(oauth, item);
    if (action === 'get') return { output: metadata };
    let response = await oauthFetch(`${item}/content`, {}, oauth);
    if (response.status === 302 || response.status === 307) {
      const location = response.headers.get('location'); await response.body?.cancel();
      const target = new URL(location ?? '');
      if (target.protocol !== 'https:' || target.username || target.password) throw new EngineError('UPSTREAM_HTTP', 'Invalid download redirect');
      // Graph returns a short-lived preauthenticated URL. Do not forward the OAuth bearer token.
      response = await ctx.services.fetch(target.href, { redirect: 'error', signal: ctx.signal });
      if (!response.ok) { await response.body?.cancel(); throw new EngineError('UPSTREAM_HTTP', `File download returned HTTP ${response.status}`); }
    }
    return { output: await fileOutput(response, str(metadata['name']), metadata) };
  }, 'microsoft', hidden);
}

export const connectedHandlers: NodeHandler[] = [googleDrive, sheets,
  graphDrive('onedriveNode', 'OneDrive', 'onedrive'), graphDrive('onedriveBusinessNode', 'OneDrive', 'onedrive', true),
  graphDrive('sharepointNode', 'SharePoint', 'sharepoint'), graphDrive('sharepointBusinessNode', 'SharePoint', 'sharepoint', true),
];
