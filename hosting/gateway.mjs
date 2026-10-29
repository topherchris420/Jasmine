// Vercel serves only this dependency-free gateway and the static Studio.
// The engine and its databases stay on a persistent Node host.
import { noticePage } from './notice.mjs';

const REQUEST_LIMIT = 4 * 1024 * 1024;
const FORWARDED = ['authorization', 'content-type', 'accept', 'origin', 'sec-fetch-site', 'idempotency-key',
  'x-api-key', 'x-project-id', 'x-bypass-cache', 'x-filename', 'x-jasmine-signature', 'x-webhook-secret', 'last-event-id'];
const RESPONSE_HEADERS = ['content-type', 'content-disposition', 'x-content-type-options', 'content-security-policy',
  'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age', 'vary', 'allow', 'retry-after'];
// Settings sent as header values: one line of visible characters. A value pasted with a line break would make
// Headers.set throw, and the platform logs that error with the whole value in it.
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const HOSTED_PAGE = /^\/apps\/(chat|search)\/[^/]+$/;

function failure(status, code, message) {
  return Response.json({ errors: [{ message, extensions: { code, retryable: status >= 500 } }] }, {
    status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

/** 'chat' or 'search' when a browser is opening a hosted page; every other caller keeps JSON errors. */
function hostedPage(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  if (!/\btext\/html\b/i.test(request.headers.get('accept') ?? '')) return undefined;
  return HOSTED_PAGE.exec(url.pathname)?.[1];
}

function notice(app, state) {
  const page = noticePage({ app, state });
  return new Response(page.body, { status: page.status, headers: page.headers });
}

async function readBody(request) {
  if (!request.body) return undefined;
  if (Number(request.headers.get('content-length')) > REQUEST_LIMIT) throw new RangeError('body');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > REQUEST_LIMIT) { await reader.cancel(); throw new RangeError('body'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function gateway(request, env, transport = fetch) {
  const url = new URL(request.url);
  // A person opening a shared chat or search link reads a page, never a JSON error or an empty 502.
  const page = hostedPage(request, url);
  let upstream;
  try {
    upstream = new URL(env.JASMINE_RUNTIME_URL);
    // A fixed, operator-owned HTTPS origin. Never derive the target from a client query/header.
    if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('url');
    if (!env.JASMINE_GATEWAY_SECRET || env.JASMINE_GATEWAY_SECRET.length < 32) throw new Error('secret');
    for (const name of ['JASMINE_GATEWAY_SECRET', 'JASMINE_PROJECT_ID']) {
      if (env[name] && !HEADER_SAFE.test(env[name])) throw new Error(`format:${name}`);
    }
  } catch (error) {
    if (page) return notice(page, 'unconfigured');
    const name = error.message.startsWith('format:') ? error.message.slice(7) : '';
    return failure(503, 'RUNTIME_NOT_CONFIGURED', name
      ? `${name} in the Vercel environment settings must be a single line with no spaces. Paste only its value, then redeploy.`
      : 'Connect your Jasmine runtime in the Vercel environment settings. See the Vercel deployment guide in the repository.');
  }
  if (!/^\/(?:api\/|graphql$|mcp$|webhooks\/|assets\/|oauth\/|apps\/(?:chat|search)\/)/.test(url.pathname)) return failure(404, 'NOT_FOUND', 'Endpoint not found');
  if (url.origin === upstream.origin) return page ? notice(page, 'unconfigured') : failure(503, 'RUNTIME_NOT_CONFIGURED', 'The runtime URL must point to the persistent engine, not this Vercel site.');
  // Assignment, rather than resolving a user-controlled URL, prevents //host redirects.
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  const headers = new Headers();
  for (const name of FORWARDED) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith('jasmine_session='));
  if (cookie) headers.set('cookie', cookie);
  headers.set('x-jasmine-gateway', env.JASMINE_GATEWAY_SECRET);
  // Every request reaches the runtime from Vercel, so name the client for its rate limits. Vercel sets x-real-ip
  // and x-forwarded-for itself, overwriting what the client sent; a client's own x-jasmine-client-ip is never forwarded.
  const client = (request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0])?.trim();
  if (client) headers.set('x-jasmine-client-ip', client);
  if (env.JASMINE_PROJECT_ID) headers.set('x-project-id', env.JASMINE_PROJECT_ID);
  let body;
  try { body = await readBody(request); }
  catch { return failure(413, 'PAYLOAD_TOO_LARGE', 'Uploads through Vercel must be under 4 MiB. Split this file or use the runtime directly.'); }
  try {
    const response = await transport(upstream, {
      method: request.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]),
    });
    // Credentials must never follow an upstream redirect to another host.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return page ? notice(page, 'unconfigured') : failure(502, 'RUNTIME_REDIRECT', 'The runtime returned a redirect. Use its final HTTPS origin in Vercel settings.');
    }
    // A tunnel or proxy in front of a runtime that is switched off answers for it, often with an empty 502.
    if (page && response.status >= 502 && response.status <= 504) {
      await response.body?.cancel();
      return notice(page, response.status === 504 ? 'timeout' : 'offline');
    }
    const output = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
    for (const name of RESPONSE_HEADERS) { const value = response.headers.get(name); if (value) output.set(name, value); }
    // Forward only our host-only session cookie; never proxy an arbitrary upstream cookie.
    for (const value of response.headers.getSetCookie()) {
      if (value.startsWith('jasmine_session=') && !/;\s*domain=/i.test(value)) output.append('set-cookie', value);
    }
    return new Response(response.body, { status: response.status, headers: output });
  } catch (error) {
    if (page) return notice(page, error.name === 'TimeoutError' ? 'timeout' : 'offline');
    return failure(error.name === 'TimeoutError' ? 504 : 502, 'RUNTIME_UNAVAILABLE', 'Jasmine could not reach its runtime. Check the runtime health and Vercel environment settings, then retry.');
  }
}
