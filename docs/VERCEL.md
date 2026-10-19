# Host Jasmine Studio on Vercel

Jasmine now ships a Vercel frontend and streaming API gateway. The existing Node engine runs on a persistent host: its SQLite databases, uploaded files, scheduler and background runs need a durable volume and an always-running process.

**Importing the repository into Vercel alone does not provision that runtime.** Without the two gateway variables below, Studio shows a connection screen and the gateway returns a useful 503 instead of creating temporary data that disappears.

This release serves **one trusted workspace per runtime**. Builders sign in with their workspace admin access key, exchanged for a seven-day, revocable HttpOnly session. It is suitable for an individual or a trusted team. It is not a public multi-tenant SaaS: there is no self-registration, organization isolation, billing or per-member role system. People who only use deployed APIs/widgets do not need Studio access.

## 1. Start the persistent runtime

Use a Docker-capable host or Node.js 24+ with persistent storage. Run exactly **one Jasmine process per data directory**; do not point multiple replicas at the same SQLite workspace.

Generate two independent values locally, and keep them private:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Run that command twice. Use one value for `JASMINE_API_KEY` (workspace access), the other for `JASMINE_GATEWAY_SECRET` (Vercel-to-runtime traffic).

Set these on the runtime:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `8787`, or the port supplied by your host |
| `JASMINE_DATA_DIR` | `/data`, mounted on a persistent volume |
| `JASMINE_API_KEY` | First generated value |
| `JASMINE_GATEWAY_SECRET` | Second generated value, at least 32 characters |
| `PUBLIC_URL` | Canonical Studio URL, such as `https://your-jasmine.vercel.app` |

The runtime generates an encryption key on the persistent volume. Keep the key and data together in backups. Alternatively, set a stable `JASMINE_SECRET_KEY` with 64 hex characters on the runtime. Do not rotate that encryption key without migrating encrypted records.

For Docker on a server, create a private `.env` file containing the three required values (`JASMINE_API_KEY`, `JASMINE_GATEWAY_SECRET`, `PUBLIC_URL`), then run:

```bash
docker compose -f compose.hosted.yml up -d --build
```

This compose file binds to localhost. Configure your host's HTTPS ingress or a TLS reverse proxy to route `https://your-runtime.example` to port 8787. Allow streaming responses; disable response buffering and use an upstream read timeout longer than 60 seconds. A managed Docker host can deploy the repository's `Dockerfile` directly, mount `/data`, and provide HTTPS for you.

`GET /healthz` returns `{ "ok": true }` without a secret for host health checks. Every other runtime route requires `x-jasmine-gateway` when gateway mode is enabled. The compose health check uses `/healthz`.

For a direct Node deployment:

```bash
npm ci
npm start
```

Set the same runtime environment and persistent directory first. Jasmine deliberately refuses to start the persistent engine inside a Vercel function.

## 2. Import the repository into Vercel

1. Import `topherchris420/Jasmine` and select branch **master**.
2. Keep the repository root as the Root Directory. The checked-in `vercel.json` sets the framework, install/build commands and output directory.
3. Add the following **server-only environment variables** in Vercel:

| Variable | Value |
| --- | --- |
| `JASMINE_RUNTIME_URL` | Runtime's final HTTPS **origin**, e.g. `https://your-runtime.example`. No path, query or credentials. |
| `JASMINE_GATEWAY_SECRET` | Exactly the same gateway secret set on the runtime |
| `JASMINE_PROJECT_ID` | Optional, only if your runtime requires that project header |

Do **not** put `JASMINE_API_KEY`, `JASMINE_SECRET_KEY` or model-provider keys in Vercel. Do not use `NEXT_PUBLIC_` or `VITE_` prefixes for secrets. The gateway does not add an admin key: API callers must still supply their own scoped key, and browsers must sign in.

4. Deploy. If Vercel assigns a different URL than expected, update `PUBLIC_URL` on the runtime to match the final Studio origin and restart the runtime.
5. Open Studio, enter the workspace access key, and follow **Getting started**.

The Vercel build copies `public/` to `dist/` and deploys a dependency-free gateway. It intentionally skips installing the engine's SQL drivers, OCR data and native image libraries on Vercel. Those dependencies are installed on the runtime instead. The gateway contains no SQLite imports and does not use `/tmp` as workspace storage.

## 3. First useful application

1. Name your workspace.
2. Optionally connect a model from Getting started or Models. Both local servers and hosted **OpenAI-compatible** APIs are supported. Enter the provider's base URL and credentials explicitly; Jasmine does not silently switch providers.
3. Choose **Your First API** from Templates. It needs no model and performs no external network request.
4. Open **Test**, send `{ "message": "Hello, Jasmine" }`, and inspect the JSON output.
5. Select **Deploy**, open Deployments, and copy an API example.
6. Create an **execute** API key under Settings for calls from your application backend. Admin keys are for trusted builders.

A cloud runtime's `127.0.0.1` is the runtime itself, not your laptop. To use Ollama or LM Studio, run it on the same private network as Jasmine or configure an authenticated endpoint reachable from the runtime. Do not expose an unauthenticated local model server to the internet.

### Flow requests to private networks

A hosted runtime refuses flow requests to loopback and private network addresses by default, and every runtime refuses link-local and cloud metadata addresses such as `169.254.169.254`. Without this, anyone holding an execute key could send `{"url": "http://169.254.169.254/..."}` to **Index a Web Page** and read the runtime's own network through the response. A refused step fails with `FORBIDDEN` and `Blocked request to <host>`.

Model connections and Integrations credentials are not affected: an Ollama server or MinIO on the runtime's private network keeps working. To let flows reach a specific internal service, set `JASMINE_EGRESS_ALLOW` on the runtime, for example `JASMINE_EGRESS_ALLOW=wiki.internal,10.2.0.0/16`, and restart. `JASMINE_PRIVATE_EGRESS=allow` opens every private network to flows; use it only when everyone who can run your flows is trusted. The runtime's startup log shows the effective policy. See [outbound requests from flows](OPERATIONS.md#outbound-requests-from-flows).

## Execution and streaming limits

- Gateway requests are limited to **4 MiB**. Split large uploads. For larger backups/uploads, use a controlled direct maintenance path to the runtime; never put a gateway secret in frontend JavaScript.
- The gateway has a **60-second function duration** and a 55-second upstream budget. Use `mode: "async"` for long executions and poll their status. A realtime request can time out at the gateway while its run continues on the runtime; use an idempotency key before retrying writes.
- Studio's GET run-event streams reconnect after a dropped/expired connection. Completed runs return a final result on reconnect. Tokens emitted during a reconnect gap are not replayed; final output and recorded node results remain available.
- POST chat/search streams are not retried automatically because replaying a POST can duplicate work. If such a stream times out, inspect the run log before sending the request again.
- Schedules, ingestion and asynchronous jobs continue on the persistent runtime. Vercel does not supply their scheduler or queue.
- Vercel previews can serve static pages, but cookie-authenticated writes and sign-in require the canonical `PUBLIC_URL`. Use a separate runtime for a fully interactive staging site. Do not share production credentials/data with unrelated previews.

## Verify the deployment

On the runtime host:

```bash
curl https://your-runtime.example/healthz
```

In Studio: open **Hosting** for configuration checks, test the first API, deploy it, and confirm the run appears in Logs. The Hosting checks inspect configuration; they do not prove that your host mounted a persistent disk or that a model provider is reachable.

Restart the runtime and verify the flow, deployment and logs remain. Export an encrypted backup in Settings and rehearse restore before relying on the workspace. Revoke an admin key to invalidate sessions created from it. Changing the environment admin key invalidates sessions created from the old environment key after restart.

For source verification:

```bash
npm ci
npm run verify
npm run build:vercel
```

The test suite covers session revocation, CSRF checks, scope isolation, gateway authentication, binary uploads, streaming, redirects, missing configuration and the no-model first API. DOM interaction tests cover onboarding and template selection. Hosted Vercel behavior still needs a deployment smoke test with your actual runtime URL.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| “Connect your Jasmine runtime” | Set both Vercel variables, then redeploy. Use an HTTPS origin without a path. |
| 403 from `/api/status` | The two gateway secrets do not match, or the runtime was configured differently. |
| Sign-in rejects the public URL | `PUBLIC_URL` must match the address bar's canonical origin, including the scheme. |
| Model shows offline | Test it under Models. Remember that cloud localhost is not your laptop. |
| A step fails with “Blocked request to …” | The flow tried to reach a private or metadata address. If that service should be reachable, add its host or CIDR range to `JASMINE_EGRESS_ALLOW` on the runtime. |
| 502/504 or a stopped live stream | Check runtime health and host logs. For a run, inspect Logs; an async job can still be running. |
| Flows disappear after restart | The runtime data directory is not on a persistent volume. |
| Large upload fails | Gateway uploads must fit under 4 MiB. |

For the underlying hosting contracts, see [Vercel's Node runtime documentation](https://vercel.com/docs/functions/runtimes/node-js) and [project configuration reference](https://vercel.com/docs/project-configuration/vercel-json).
