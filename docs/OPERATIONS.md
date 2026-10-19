# APIs, triggers and operations

Use `Authorization: Bearer <key>` when keys are configured. Admin keys manage configuration; execute keys run deployed flows, inspect status and submit feedback. Local Studio starts without an account. `JASMINE_PROJECT_ID` optionally checks `x-project-id` on authenticated routes.

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

The server binds to localhost by default. Tune `JASMINE_MAX_CONCURRENT_RUNS`, `JASMINE_MAX_QUEUED_RUNS` and `JASMINE_NODE_CONCURRENCY` for your hardware. `JASMINE_IP_ALLOWLIST` accepts comma-separated addresses/CIDR subnets and checks the actual connecting socket, not forwarded headers. Use one process per data directory.

## Outbound requests from flows

A flow's URLs often come from the request that started it: `{"url": "..."}` for **Index a Web Page**, `documentUrl` for the OCR and PDF templates. Anyone who can run that flow chooses where the runtime connects. Jasmine therefore checks every request a flow makes against an egress policy before connecting.

| Address | Policy |
|---|---|
| Link-local (`169.254.0.0/16`, `fe80::/10`, which includes the `169.254.169.254` cloud metadata service), `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal` and other metadata hostnames, `0.0.0.0/8`, multicast, broadcast and reserved space | Always blocked. No setting opens them. |
| Loopback (`127.0.0.0/8`, `::1`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT `100.64.0.0/10`, `192.0.0.0/24`, `198.18.0.0/15`, unique-local `fc00::/7` and site-local `fec0::/10` | `JASMINE_PRIVATE_EGRESS`: `allow` or `deny`. |
| Everything else | Allowed. |

Without `JASMINE_PRIVATE_EGRESS`, a hosted runtime (`JASMINE_GATEWAY_SECRET` set, or `PUBLIC_URL` pointing anywhere but loopback) denies private networks, and a local one allows them, so flows on your own machine keep calling `http://localhost` services and intranet pages. To let a hosted runtime reach specific internal services, list them in `JASMINE_EGRESS_ALLOW`: exact hostnames (`wiki.internal`), subdomain wildcards (`*.corp.example`, which does not match `corp.example` itself), addresses or CIDR ranges (`10.2.0.0/16`, `fd12::/16`). An allowed hostname may resolve to private addresses; it never makes an always-blocked address reachable. IPv4-mapped, translated, NAT64 and 6to4 IPv6 forms are judged by the IPv4 address they contain. An invalid value stops the runtime at startup. The runtime logs the effective policy once at startup, for example `egress: flows may not reach private networks (default for a hosted runtime) except wiki.internal; link-local and cloud metadata addresses are always blocked`.

The policy applies to the API node and agent HTTP tools, the scraper, crawler and Scrape & Crawl nodes, RSS feeds, file downloads from URLs (documents, OCR, PDF, image inputs, Gmail attachments), connected Google, Microsoft and Webflow APIs, Code-node and code-tool `fetch`, and URL or crawl ingestion into a knowledge collection. The check runs on the address the connection actually uses, after DNS resolution, so a hostname cannot pass the check and then resolve elsewhere. A hostname must not resolve to any refused address. Redirects are followed one hop at a time (at most 20), each hop is checked again, and cross-origin hops drop `Authorization` and `Cookie`, as fetch does. A crawl skips links to refused addresses; a refused start page fails the step.

A refused request fails its step with `FORBIDDEN` (`Blocked request to <host>: ...`), naming `JASMINE_PRIVATE_EGRESS` and `JASMINE_EGRESS_ALLOW`. It is never retried, and nothing from the refused address is read.

Endpoints an admin enters under **Models** or **Integrations** are configuration rather than flow data, so they are not subject to the policy: model connections and their discovery and diagnostics, SearXNG, n8n, GitHub Enterprise, Slack/Teams/Discord webhooks, S3 endpoints, MCP servers, SMTP and SQL servers. A local Ollama, LM Studio or MinIO keeps working with private egress denied. Flow data still fills in their paths and bodies; with virtual-hosted S3 addressing, bucket names must be DNS-compatible so a bucket cannot change the endpoint's host.
