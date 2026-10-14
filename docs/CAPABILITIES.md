# Jasmine capabilities

Jasmine owns its Studio, APIs, execution engine, storage and deployments. No external workflow platform or user account is required. Inference follows your configured model connection, with no automatic hosted-model fallback.

| Area | Implemented behavior | Practical boundary |
|---|---|---|
| Builder | Nodes, connections, branch handles, loops, notes, undo, reference picker, tags, validation, tests, local assistant and validated draft proposals | DOM interaction tests verify selected controls. Pixel rendering and full browser interaction have not been validated in this environment. |
| Runtime | Parallel scheduling, conditions, classifiers, loops, batches, agents, sub-flows, retries, fallbacks, cancellation, deadlines, bounded queues | One process. Completed results/retry state persist; interrupted in-flight work is marked failed rather than resumed at a checkpoint. |
| Models | Ollama/OpenAI-compatible connections, local alias mapping, streaming, structured output, tools, embeddings, images/vision and image-generation endpoint support | Selected servers/models must implement the requested operation. No hosted-model credentials are bundled. |
| Model comparison | Same user cases across selected local models; latency, tokens and optional expected-substring checks | Measurements and explicit checks, not a general quality leaderboard. |
| Retrieval | SQLite vectors, FTS5/BM25, exact cosine scans, hybrid fusion, metadata filters and persistent memory | Built-in embeddings are lexical. Learned local embeddings provide semantic retrieval. No distributed ANN index. |
| Ingestion | Text, PDF text, DOCX/PPTX/XLSX/CSV/Markdown/HTML, scraping, crawling, folder sync, connected file extraction | Format support and download sizes are bounded. Scheduled sources poll returned records and do not implement every provider's incremental change protocol. |
| OCR | Bundled offline English OCR, page confidence, word boxes, embedded PDF figures with page fallback, local-model JSON/vision annotation | 50 PDF pages, 16 million pixels per image, rendered dimension up to 4096. Advanced table/header/footer parsing, other languages, masks and every document layout are not fully supported. |
| PDF editing | Merge with ranges/bookmarks; split; extract/delete/insert/reorder/duplicate pages; bookmarks; metadata | 1–50 source files, 500 bookmarks, depth 10. Encrypted PDFs and arbitrary outline actions are not fully supported. Links are time-limited signed local assets. |
| Integrations | Native app adapters, Google/Microsoft OAuth, Gmail, Webflow, HTTP, SMTP, PostgreSQL/MySQL/SQL Server, S3 copy/move, outbound MCP | Actions are listed in the catalog. Own credentials required. Request fixtures and driver mocks do not prove live access to every account or database. |
| Triggers | APIs, signed HTTP webhooks, widgets, cron/time zones, folder sync, scheduled source reads, real inbound SMTP | SMTP is opt-in and local. Internet delivery needs a separately configured relay/MX route. Provider-specific event subscriptions use generic webhook plumbing. |
| Deployment | Immutable local versions, version pinning, rollback and Docker packaging | Activation on your server; no managed global edge, distributed autoscaling or service-level guarantee. |
| Cache | Opt-in encrypted response cache; context/version keys; clear policy; bypass header; side-effect/agent/sub-flow exclusions | TTL 1–86400 seconds. A hit references the original execution record. Read-only upstream data may change within the TTL; bypass or clear when needed. |
| APIs | REST/GraphQL, async status, SSE, cancel/retry/trace, feedback and scopes | Durable idempotency records last 24 hours by default. No exactly-once guarantee for external side effects or crash recovery. |
| MCP | Stateless JSON-RPC over HTTP, deployed flow tools/schemas, graph refresh, docs/templates and scoped management tools | Protocol versions 2025-03-26/2025-06-18; no server-push session, GET event stream or every feature of newer MCP revisions. |
| SDKs/CLI | JS/Python/Go execution clients, JS SSE, optional React/Next.js hook/chat component, local management CLI | React supplied by consuming app. CLI manages one selected server/workspace; it does not create a managed cloud account. |
| Monitoring | Persistent runs, reports, node timelines, exports, local alerts, per-run/batch feedback | Alerts stay local. Token reports distribute aggregate run usage among models; no external delivery or provider billing reconciliation. |
| Workspace | Draft conflict checks, encrypted credentials/secrets, hashed keys, prompt library, tags, export/import and encrypted full backups | One workspace per data directory. JSON project import currently imports drafts only; full backup restores into a separate directory. No organization, team invitations, fine-grained roles or collaborative editing. |
| Backup | SQLite snapshots, table data, vectors, files, drafts, credentials and encryption key inside a scrypt/AES-GCM envelope | 100 MB export budget counting base64 database sizes and raw files. Each DB snapshot is consistent; the entire live workspace is not a cross-resource transaction. Stop writes for a coordinated backup. |
| Access | Optional API keys, admin/execute scopes, widget domains, IP/CIDR allowlist | API access control, not enterprise SSO or a multi-user identity system. Worker code limits are not an OS security boundary. |

## Verification

Run `npm run typecheck`, `npm run check:scripts` and `npm test`. CI adds Linux/Windows execution, Docker boot and Go SDK tests. The [feature matrix](PARITY.md) names evidence for each area.

`npm run smoke:local` requires a model server on your machine. It exercises generation, embeddings, ingestion and RAG. Live model quality, external account permissions and database connectivity remain environment-specific.
