import { EngineError } from '../errors.ts';

export type OAuthProvider = 'google' | 'microsoft';
export interface OAuthOptions {
  provider: OAuthProvider;
  credentials: Record<string, string>;
  fetch: typeof fetch;
  signal: AbortSignal;
  saveTokens?: (tokens: Record<string, string>) => void;
}

/** Fixed provider token endpoints; credentials never follow API redirects. */
export async function oauthFetch(url: string, init: RequestInit, options: OAuthOptions): Promise<Response> {
  const c = options.credentials;
  let token = c['accessToken'] || c['token'];
  const refresh = async () => {
    if (!c['refreshToken'] || !c['clientId']) throw new EngineError('FORBIDDEN', 'Configure an access token or an OAuth client id and refresh token under Integrations');
    const tenant = c['tenantId'] || 'common';
    if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw new EngineError('BAD_PAYLOAD', 'Invalid Microsoft tenant id');
    const endpoint = options.provider === 'google' ? 'https://oauth2.googleapis.com/token' : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: c['clientId'], refresh_token: c['refreshToken'] });
    if (c['clientSecret']) form.set('client_secret', c['clientSecret']);
    const response = await options.fetch(endpoint, { method: 'POST', redirect: 'error', signal: options.signal, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EngineError('FORBIDDEN', `OAuth refresh returned HTTP ${response.status}; reconnect the account`);
    }
    const body = await response.json() as { access_token?: unknown; refresh_token?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new EngineError('PROVIDER', 'OAuth response has no access token');
    const tokens = { accessToken: body.access_token, ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}) };
    Object.assign(c, tokens);
    options.saveTokens?.(tokens);
    return body.access_token;
  };
  if (!token) token = await refresh();
  const request = () => options.fetch(url, { ...init, redirect: 'manual', signal: options.signal, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` } });
  let response = await request();
  if (response.status === 401 && c['refreshToken']) {
    await response.body?.cancel();
    token = await refresh();
    response = await request();
  }
  if (!response.ok && response.status !== 302 && response.status !== 307) {
    await response.body?.cancel();
    throw new EngineError(response.status === 429 ? 'RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'UPSTREAM_HTTP', `Connected service returned HTTP ${response.status}`, { retryable: response.status === 429 || response.status >= 500, details: { status: response.status } });
  }
  return response;
}

export async function boundedBytes(response: Response, limit = 25 * 1024 * 1024): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new EngineError('BAD_PAYLOAD', 'Connected file exceeds 25 MB'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new EngineError('BAD_PAYLOAD', 'Connected file exceeds 25 MB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
