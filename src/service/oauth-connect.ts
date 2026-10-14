import { createHash, randomBytes } from 'node:crypto';
import type { Jasmine } from '../app.ts';
import { EngineError } from '../errors.ts';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const providers: Record<string, 'google' | 'microsoft'> = {
  'google-drive': 'google',
  'google-sheets': 'google',
  gmail: 'google',
  onedrive: 'microsoft',
  sharepoint: 'microsoft',
};
interface State {
  provider: string;
  integration: string;
  name: string;
  verifier: string;
  readOnly: boolean;
}
/** Self-registered OAuth clients with PKCE, one-use state and encrypted token storage. */
export class OAuthConnect {
  constructor(app: Jasmine) {
    this.app = app;
  }
  private readonly app: Jasmine;
  configure(
    provider: string,
    input: { clientId: string; clientSecret?: string; redirectUri: string; tenantId?: string },
  ) {
    if (!['google', 'microsoft'].includes(provider) || typeof input.clientId !== 'string' || !input.clientId.trim())
      throw new EngineError('BAD_PAYLOAD', 'Select Google/Microsoft and provide a client id');
    const uri = new URL(input.redirectUri);
    if (
      !['http:', 'https:'].includes(uri.protocol) ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash ||
      uri.pathname !== `/oauth/callback/${provider}`
    )
      throw new EngineError('BAD_PAYLOAD', `Use your Jasmine URL followed by /oauth/callback/${provider}`);
    const prior = this.app.credentials.list('oauth-client').find((c) => c.name === provider);
    this.app.credentials.upsert({
      ...(prior ? { id: prior.id } : {}),
      integration: 'oauth-client',
      name: provider,
      data: input,
    });
    return { configured: true };
  }
  configurations() {
    return ['google', 'microsoft'].map((provider) => {
      const c = this.app.credentials.resolve(provider, 'oauth-client');
      return {
        provider,
        configured: !!c,
        clientId: c?.['clientId'] ?? '',
        redirectUri: c?.['redirectUri'] ?? '',
        tenantId: c?.['tenantId'] ?? 'common',
        hasClientSecret: !!c?.['clientSecret'],
      };
    });
  }
  begin(integration: string, name: string, readOnly = true) {
    const provider = providers[integration];
    if (!provider || !name?.trim() || name.length > 100)
      throw new EngineError('BAD_PAYLOAD', 'Select a supported integration and credential name');
    const c = this.app.credentials.resolve(provider, 'oauth-client');
    if (!c) throw new EngineError('BAD_PAYLOAD', `Configure a ${provider} OAuth client first`);
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url'),
      challenge = createHash('sha256').update(verifier).digest('base64url');
    this.app.db.run('DELETE FROM oauth_states WHERE expires_at<=?', Date.now());
    this.app.db.run(
      'INSERT INTO oauth_states(state_hash,secret,expires_at) VALUES(?,?,?)',
      hash(state),
      this.app.box.sealJson({ provider, integration, name, verifier, readOnly }),
      Date.now() + 10 * 60000,
    );
    const suffix =
      integration === 'google-drive'
        ? readOnly
          ? 'drive.readonly'
          : 'drive'
        : integration === 'google-sheets'
          ? readOnly
            ? 'spreadsheets.readonly'
            : 'spreadsheets'
          : readOnly
            ? 'gmail.readonly'
            : 'gmail.modify';
    const scope =
      provider === 'google'
        ? `https://www.googleapis.com/auth/${suffix}`
        : `offline_access User.Read ${integration === 'sharepoint' ? (readOnly ? 'Sites.Read.All' : 'Sites.ReadWrite.All') : readOnly ? 'Files.Read' : 'Files.ReadWrite'}`;
    const tenant = c['tenantId'] || 'common';
    if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw new EngineError('BAD_PAYLOAD', 'Invalid tenant id');
    const url = new URL(
      provider === 'google'
        ? 'https://accounts.google.com/o/oauth2/v2/auth'
        : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    );
    url.search = new URLSearchParams({
      client_id: c['clientId']!,
      redirect_uri: c['redirectUri']!,
      response_type: 'code',
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { response_mode: 'query' }),
    }).toString();
    return { authorizationUrl: url.href, expiresInSeconds: 600 };
  }
  async finish(provider: string, state: string, code: string) {
    if (!state || state.length > 200 || !code || code.length > 10000)
      throw new EngineError('BAD_PAYLOAD', 'Missing OAuth state or code');
    const row = this.app.db.get<{ secret: string }>(
      'SELECT secret FROM oauth_states WHERE state_hash=? AND expires_at>?',
      hash(state),
      Date.now(),
    );
    if (!row) throw new EngineError('FORBIDDEN', 'OAuth state is invalid, expired or already used');
    const value = this.app.box.openJson<State>(row.secret);
    if (value.provider !== provider) throw new EngineError('FORBIDDEN', 'OAuth provider mismatch');
    this.app.db.run('DELETE FROM oauth_states WHERE state_hash=?', hash(state));
    const c = this.app.credentials.resolve(provider, 'oauth-client')!;
    const tenant = c['tenantId'] || 'common';
    const endpoint =
      provider === 'google'
        ? 'https://oauth2.googleapis.com/token'
        : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: c['clientId']!,
      redirect_uri: c['redirectUri']!,
      code,
      code_verifier: value.verifier,
    });
    if (c['clientSecret']) form.set('client_secret', c['clientSecret']);
    const response = await this.app.services.fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EngineError('FORBIDDEN', `Account connection returned HTTP ${response.status}`);
    }
    const tokens = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof tokens.access_token !== 'string') throw new EngineError('PROVIDER', 'Provider returned no access token');
    const existing = this.app.credentials.list(value.integration).find((c) => c.name === value.name);
    return this.app.credentials.upsert({
      ...(existing ? { id: existing.id } : {}),
      integration: value.integration,
      name: value.name,
      data: {
        clientId: c['clientId'],
        clientSecret: c['clientSecret'],
        tenantId: c['tenantId'],
        accessToken: tokens.access_token,
        ...(typeof tokens.refresh_token === 'string' ? { refreshToken: tokens.refresh_token } : {}),
      },
    });
  }
}
