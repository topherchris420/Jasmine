# APIs, triggers and operations

Use `Authorization: Bearer <key>` when keys are configured. Admin keys manage configuration; execute keys run deployed flows, inspect status and submit feedback. Local Studio starts without an account. `JASMINE_PROJECT_ID` optionally checks `x-project-id` on authenticated routes; `GET /api/status` reports it as `requiredProjectId`. GraphQL `runHistory` needs an admin key.

Browser protections apply in every mode:

- `POST`, `PUT` and `DELETE` requests to the Studio and APIs carrying another site's `Origin` are refused, even with a key. Only the widget, webhook and OAuth callback routes answer CORS preflights. Call the APIs from a server, an SDK or the Studio itself.
- JSON endpoints require `Content-Type: application/json`. File uploads (`/api/files`) and webhooks keep accepting other types.
- Without an admin key (and, for execution routes, without any key), requests must be addressed to `localhost`, a loopback address, `PUBLIC_URL`'s host or a name in `JASMINE_ALLOWED_HOSTS`. This blocks DNS-rebinding pages; it is not network access control, so set `JASMINE_API_KEY` before exposing the port. If only execute keys exist, the Studio stays open; Jasmine warns at startup and when such a key is created.
- Behind a proxy that rewrites `Host`, set `PUBLIC_URL` to the browser-facing origin.
- Changing a model connection's base URL without entering a key clears its stored key.
- GraphQL queries are limited to 64 KB, 5000 tokens, 500 selected fields, 20 levels and 10 selections of one response name per selection set (fewer when repeated fields have sub-selections); use aliases for repeated fields.

## Execute and inspect

`POST /api/v1/flows/:id/execute` accepts `{ "payload": {}, "mode": "realtime" }`. Use `mode: "async"` for immediate acceptance, then `GET /api/v1/runs/:requestId`. Pass `version` to pin a retained deployment. `Idempotency-Key` binds the flow and payload to one request for 24 hours, including across restart; a conflicting payload returns a conflict.

`POST /api/v1/runs/:id/cancel`, `/retry` and `GET /api/v1/runs/:id/trace` provide control and traces. `GET /api/runs/:id/events` streams trace, progress, token and completion events. Retry uses the original version/input and completed successful steps. Completed top-level node outputs are checkpointed before dependent work starts. After a process crash, Jasmine marks the run interrupted and exposes the saved records/trace. Explicit retry reuses those completed steps. It does not resume individual unfinished loop/agent iterations; ambiguous external operations may repeat. Checkpoint write failures stop scheduling dependent work.

GraphQL exposes equivalent execution/status/retry/cancel operations at `POST /graphql`. The [schema](../src/api/graphql.ts) and Studio API Playground list fields.

## Feedback

```graphql
mutation Feedback($requestId: String!) {
  submitFeedback(requestId: $requestId, rating: 5, comment: "Helpful", metadata: {source: "chat"}) {
    success message data error
  }
}
```

REST: `POST /api/feedback` with the same fields. Supply exactly one `requestId` or `requestIds` (up to 25). At least one rating, weight, nonempty comment or metadata value is required. Ratings are integers 0–255, weights 0–1, comments up to 5000 characters and metadata up to 16 KB/depth 5/100 keys. Duplicate ids are ignored; missing runs produce per-request failure results. Run detail and Reports show feedback.

## Response cache

Set `{ "enabled": true, "ttlSeconds": 3600 }` with `PUT /api/flows/:id/cache` or use Deployments. Caching defaults to off; TTL is 1–86400 seconds. Clear with `DELETE` on the same endpoint. `X-Bypass-Cache: true` forces execution.

The key includes payload, deployed version, models, knowledge, credentials and project configuration. Declared side effects, agents and sub-flows bypass the cache. A cached response includes `cached: true` and the original request id. External read-only data can change independently; choose a suitable TTL or bypass.

## Local SMTP reception

Deploy a flow with **Inbound Email** and start the listener:

```bash
MAIL_PORT=2525 MAIL_HOST=127.0.0.1 MAIL_DOMAIN=localhost npm start
```

Deployments displays the recipient; `GET /api/mailhooks` lists addresses. The recipient remains stable when redeploying the flow. Only active mail flows accept mail. Parsed payloads include `webhookId`, `to`, `from`, `subject`, `text`, `html` and saved attachments. This is a local SMTP listener; configure your own relay/MX routing for internet delivery. TLS/relay administration is outside this listener.

## MCP

Connect a Streamable HTTP client to `/mcp` with the appropriate API key. It supports initialization, ping, tools list/call and catalog resources. Dynamic deployed-flow tools carry the trigger input schema. Graph tools list/refresh/execute flows and check run status. Documentation/template tools provide local context. Admin tools can read/save/validate/deploy/rollback/delete drafts and manage contexts. Each call checks key scope.

The endpoint is stateless and returns JSON; notifications receive HTTP 202. It supports protocol revisions 2025-03-26 and 2025-06-18. Outbound **MCP Agent** nodes connect local models to other MCP servers separately.

## Encrypted backups

Use Settings, or `POST /api/backups` with `{ "passphrase": "at-least-twelve-characters" }`. The response is a passphrase-encrypted JSON envelope containing SQLite snapshots, local tables, vectors, drafts, files, credentials and the encryption key. Keep the passphrase separately.

`POST /api/backups/restore` accepts `{ "backup": <envelope>, "passphrase": "..." }`. It creates and validates a separate workspace and returns `dataDir`. Stop the old process and start Jasmine with `JASMINE_DATA_DIR` pointing there. Schedules and model probes are disabled during validation. Restoring does not replace the active directory.

The export budget is 100 MB counting base64 database sizes and raw files. Stop application writes when you need a coordinated snapshot across databases, files and drafts. For larger workspaces, stop Jasmine and back up the entire data directory. If restored with a different origin, update `PUBLIC_URL`, OAuth callbacks and externally configured webhook URLs.

## Models, documents and access

Models offers user-defined comparisons of 1–8 models across 1–20 cases. Each result reports text, latency, tokens and an optional expected-substring check. It is not a general quality score.

Document Intelligence runs offline English OCR and can use a local model for JSON/vision annotation. Generated files use short-lived encrypted links under `/assets/:id`. Set `PUBLIC_URL` to your reachable Jasmine origin when returning these links to another application. URLs expire; stored files remain subject to workspace management.

The server binds to localhost by default. Tune `JASMINE_MAX_CONCURRENT_RUNS`, `JASMINE_MAX_QUEUED_RUNS` and `JASMINE_NODE_CONCURRENCY` for your hardware. `JASMINE_IP_ALLOWLIST` accepts comma-separated addresses/CIDR subnets, checks the actual connecting socket (not forwarded headers). Loopback is not exempt, because a reverse proxy on the same host connects over loopback; the one exception is a loopback `GET /api/status`, so container health checks keep working. Behind a local proxy, list `127.0.0.1` only if the proxy does its own filtering. Widget and webhook rate limits key IPv6 clients by /64. New data directories are created owner-only (0700) and the SQLite files are kept at 0600. Use one process per data directory.
