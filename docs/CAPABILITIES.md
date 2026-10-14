# Jasmine capabilities

Jasmine is a standalone application: its own Studio, APIs, execution engine, local storage, and deployment model. No remote workflow platform is required.

| Area | Implemented behavior | Practical boundary |
|---|---|---|
| Builder | Movable nodes, connections, branch handles, loops, notes, undo, configuration, reference picker, validation, test events | Schema-driven JavaScript Studio; browser interaction QA depends on browser-control availability. |
| Runtime | Parallel ready-set scheduling, conditions, classifiers, loops, concurrent batches, sub-flows, tool agents, retries, fallbacks, cancellation, deadlines | Single local process; no distributed durable execution queue. Restarted in-flight runs are marked interrupted. |
| Models | Ollama and OpenAI-compatible connections, local alias mapping, streaming, structured output, tools, embeddings, images/vision where supported | Models must support requested operations. Inference quality and hardware capacity depend on the selected model and server. |
| Retrieval | Persistent SQLite vectors, FTS5/BM25, exact cosine scan, hybrid score/rank fusion, metadata filtering | Built-in embeddings are lexical. Use a learned local embedding model for semantic retrieval; exact scans are not distributed ANN. |
| Ingestion | Text, PDF text layers, DOCX, PPTX, XLSX, CSV, Markdown, HTML, web scraping and crawling, local folder sync | Scanned PDFs require OCR. Not all layouts, encodings, or binary formats are supported. |
| Integrations | App APIs, HTTP, web tools, SMTP, PostgreSQL, S3, MCP, Google Drive/Sheets, Graph files | Own service credentials and permissions required; no shared OAuth onboarding. MySQL and SQL Server adapters are explicitly unavailable. |
| Deployment | Immutable local versions, rollback, version-pinned runs, signed webhooks, widgets, schedules, Docker packaging | Deploy means activating a compiled flow on your Jasmine server. No managed global edge network or automatic horizontal scaling. |
| APIs | GraphQL, REST, async status, SSE, trace/cancel/retry, API scopes, JS/Python clients | Idempotency deduplication is process-local with a bounded retention window, not a durable exactly-once guarantee. |
| Monitoring | Persistent run records, filtered reports, timelines, trace exports, local alert rules and acknowledgement | Alerts appear locally; they do not send external notifications. Model token reports distribute run totals across used models. |
| Project | Draft conflicts, encrypted secrets/credentials, hashed keys, prompt library, project metadata export | One workspace per data directory. Project export omits secrets and vector contents; it is not a full backup. |

## Local data and identity

The SQLite database, workspace snapshot, uploaded files, and encryption key live in `JASMINE_DATA_DIR`. Back up the whole directory. Deployment state, run logs, credentials, collections, sessions, and alerts survive restart. Code workers impose deadlines and memory bounds; they are not an OS isolation boundary.

## Verification

`npm run typecheck`, `npm test`, and `npm run check:scripts` verify source contracts, runtime regressions, APIs, providers, retrieval, SDK requests, adapter fixtures, and persisted alert/deployment behavior. CI runs the Node checks on Linux and Windows and adds a Docker boot smoke test.

`npm run smoke:local` exercises chat, document ingestion, and RAG against a model server you are running. Passing fixture tests does not establish model quality, live-account access, or throughput on your machine.
