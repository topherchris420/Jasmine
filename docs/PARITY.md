# Feature verification and equivalence

Jasmine aims to cover a complete visual AI workflow lifecycle with local inference and its own identity. This document records what exists, how it is tested, and where equivalence remains incomplete. **Complete feature-for-feature equivalence has not been established.** Public feature descriptions, compatible graph shapes and passing local tests cannot establish identical behavior, model quality, UI details or infrastructure guarantees.

The scope intentionally excludes hosted sign-in, inherited branding, managed billing and mandatory hosted inference. Local API keys and separately authorized service accounts remain available. Differences beyond those exclusions are listed below rather than silently counted as matches.

## Feature matrix

“Implemented” means a working Jasmine implementation with the listed evidence. “Partial” means material behavior or scale differs. Tests using fixtures prove those fixture contracts, not access to a live external service. A listed test file may cover representative behavior rather than every configuration.

| Feature | Coverage | Evidence | Remaining boundary |
|---|---|---|---|
| Visual node canvas and connections | Implemented | `test/studio.test.ts`, `test/studio-interactions.test.ts` | Full browser/pixel acceptance pending |
| Node fields, upstream references and schema hints | Implemented | `test/studio.test.ts`, `test/template.test.ts` | Different independent Studio layout |
| Branch handles, loops, batches and notes | Implemented | `test/studio.test.ts`, `test/compile.test.ts`, `test/executor.test.ts` | UI interactions need broader browser coverage |
| Undo, draft persistence and revision conflicts | Implemented | `test/workspace.test.ts`, `test/studio.test.ts` | No concurrent collaborative editing |
| Tags, search and starter templates | Implemented | `src/app.ts`, `public/js/pages/flows.js`, `examples/templates/` | Tag UI lacks dedicated interaction coverage |
| Flow import, export and reference inlining | Partial | `test/compile.test.ts`, `test/workspace.test.ts` | Project JSON import imports drafts only; no universal export compatibility |
| Graph compilation and diagnostics | Implemented | `test/compile.test.ts`, `test/properties.test.ts` | Only executable supported node types compile |
| Parallel dependency scheduling | Implemented | `test/executor.test.ts`, `docs/BENCHMARKS.md` | Single process |
| Conditions and classifiers | Implemented | `test/executor.test.ts`, `test/agents.test.ts` | Model-dependent classification quality |
| Loops and concurrent batches | Implemented | `test/executor.test.ts`, `test/properties.test.ts` | Bounded by node and run budgets |
| Sub-flows and supervisor agents | Implemented | `test/agents.test.ts`, `test/services.test.ts` | Bounded nesting and agent steps |
| JavaScript transformations | Partial | `test/code-runtime.test.ts` | Worker isolation; no full OS sandbox or arbitrary package environment |
| HTTP calls, waits and variables | Implemented | `test/integrations.test.ts`, `test/executor.test.ts` | HTTP behavior depends on upstream services |
| Retries, fallback, deadlines and cancellation | Implemented | `test/services.test.ts`, `test/executor.test.ts` | External side effects cannot be guaranteed exactly once |
| Completed idempotent results across restart | Implemented | `test/parity-platform.test.ts` | Default 24-hour key window; in-flight crashes are interrupted |
| Retry failed/interrupted work after restart | Implemented | `test/extended-contracts.test.ts`, `test/recovery.test.ts` | Completed top-level checkpoints; unfinished loop/agent iterations may repeat |
| Local Ollama and compatible model connections | Implemented | `test/providers.test.ts`, `test/local-stack.test.ts` | Fixture protocols; real hardware smoke required |
| Per-node models, aliases and streaming | Implemented | `test/providers.test.ts`, `test/api.test.ts` | Capability depends on configured model |
| Tool use, structured JSON and vision | Implemented | `test/agents.test.ts`, `test/providers.test.ts` | Accuracy differs by model; no universal cloud-provider behavior |
| Image generation | Partial | `src/llm/`, `src/nodes/ai.ts` | Requires an image-capable compatible local endpoint |
| Prompt library | Implemented | `test/platform.test.ts` | No multi-user prompt collaboration |
| Local editor assistant | Implemented | `test/parity-platform.test.ts`, `test/studio-interactions.test.ts` | Local-model quality; explicit reviewed draft apply |
| User-defined model comparisons | Implemented | `src/service/model-evals.ts`, `public/js/pages/models.js` | Latency/tokens/substrings, not a universal evaluation benchmark |
| Document formats and chunking | Implemented | `test/local-stack.test.ts`, `test/rag.test.ts` | Bounded parsers/layout support |
| Offline document OCR and figures | Partial | `test/parity-platform.test.ts`, `test/extended-contracts.test.ts` | English/50 pages; advanced table structure and full provider accuracy absent |
| Local-model document JSON/vision annotation | Partial | `src/nodes/documents.ts`, schema tests in `test/agents.test.ts` | Document-specific real-model evaluation pending |
| PDF merge/split/page operations | Implemented | `test/parity-platform.test.ts` | Encrypted PDFs not fully supported |
| PDF bookmarks and metadata | Partial | `test/parity-platform.test.ts`, `test/extended-contracts.test.ts` | Direct outline destinations; not every PDF action/named destination |
| Learned embeddings and vector persistence | Implemented | `test/rag.test.ts`, `test/local-stack.test.ts` | Learned model required for semantic quality |
| Vector, keyword and hybrid retrieval | Partial | `test/rag.test.ts`, `test/local-stack.test.ts` | Exact scan, not distributed ANN/performance parity |
| Metadata filters and conversation memory | Implemented | `test/rag.test.ts`, `test/platform.test.ts` | Local persistence/retention limits |
| Web crawling, scraping and RSS | Implemented | `test/integrations.test.ts`, `test/local-stack.test.ts` | No universal browser-rendered page extraction |
| Google Drive/Sheets, OneDrive/SharePoint | Partial | `test/connected.test.ts` | Listed file/value actions; not complete provider APIs |
| Self-registered OAuth and token rotation | Implemented | `test/extended-contracts.test.ts`, `test/connected.test.ts` | Own registration and live consent required |
| Gmail mailbox/draft/send/reply | Partial | `test/parity-platform.test.ts`, `src/nodes/connected.ts` | Representative fixture coverage; not every Gmail action |
| Webflow CMS/page reads | Partial | `test/parity-platform.test.ts` | Read actions; not full CMS publishing/writes |
| Slack/Teams/Discord/Telegram and SMTP | Partial | `test/integrations.test.ts` | Listed actions; native event subscriptions vary |
| Notion/Airtable/GitHub/Twilio/n8n | Partial | `test/integrations.test.ts` | Representative adapters; not every external action |
| PostgreSQL/MySQL/SQL Server | Implemented | `test/database-adapters.test.ts`, `test/integrations.test.ts` | Driver contracts/mocks; live DB integration pending |
| Local relational tables | Implemented | `test/integrations.test.ts`, `test/parity-platform.test.ts` | SQLite, not a distributed database service |
| S3 storage, sharing, copy/move | Partial | `test/s3-copy.test.ts`, `test/s3-pagination.test.ts`, `test/integrations.test.ts` | Bounded pagination and signed session tokens; no multipart or automatic token renewal |
| Outbound MCP tools | Implemented | `test/integrations.test.ts`, `test/agents.test.ts` | Supported Streamable HTTP subset |
| Inbound Graph/management/docs MCP | Partial | `test/parity-platform.test.ts` | Stateless tools/resources, not all session/protocol features |
| Signed webhook and API triggers | Implemented | `test/api.test.ts`, `test/platform.test.ts` | Generic payloads; own provider subscriptions |
| Cron/time zones and incremental folder sync | Implemented | `test/platform.test.ts` | Server must be running |
| Scheduled app/database source reads | Partial | `test/extended-contracts.test.ts` | Polling returned lists, not every incremental change feed |
| Inbound email trigger | Implemented | `test/parity-platform.test.ts` | Real local SMTP; external mail routing not bundled |
| Immutable deployments and rollback | Implemented | `test/services.test.ts`, `test/platform.test.ts` | Local server activation |
| Managed global edge and autoscaling | Absent | — | Requires separate distributed infrastructure |
| Chat, ask and search widgets | Implemented | `test/platform.test.ts`, `test/studio.test.ts` | Full browser/widget acceptance pending |
| REST/GraphQL, async status and SSE | Implemented | `test/api.test.ts`, `test/standalone.test.ts` | Not a guarantee of every undocumented external contract |
| Encrypted response cache and bypass | Implemented | `test/parity-platform.test.ts` | Opt-in safe-flow policy; original request provenance |
| Feedback API and report summary | Implemented | `test/parity-platform.test.ts` | Ratings 0–255; batch up to 25; local reporting |
| JavaScript/Python/Go clients | Implemented | `test/standalone.test.ts`, `sdk/go/client_test.go` | Go tests run with `go test` in `sdk/go`; client features differ by language |
| React/Next.js hook and chat component | Implemented | `test/react-sdk.test.mjs` | Optional consumer React; DOM simulation |
| CLI management and execution | Implemented | `test/extended-contracts.test.ts` | Single selected workspace; no cloud account lifecycle |
| Persistent logs, trace export and reports | Implemented | `test/platform.test.ts`, `test/standalone.test.ts` | Aggregate usage, local retention |
| Local alert inbox | Partial | `test/standalone.test.ts`, `test/studio-interactions.test.ts` | External notification delivery absent |
| Full encrypted backup and restore | Implemented | `test/parity-platform.test.ts`, `test/extended-contracts.test.ts` | Separate-directory restore and 100 MB budget |
| API scopes, encrypted secrets and IP limits | Implemented | `test/api.test.ts`, `test/platform.test.ts`, `src/api/server.ts` | Coarse local scopes; no enterprise identity system |
| Organizations, projects portal and team roles | Absent | — | One workspace per server/data directory |
| Docker deployment | Implemented | `Dockerfile`, `docker-compose.yml` | Image health check; boot is verified manually, not a managed hosting service |

## Improvements built into Jasmine

- Local inference and bundled English OCR run without hosted AI credentials or an OCR CDN.
- Draft proposals require deterministic compilation and revision checks before explicit application.
- Exact execution results are encrypted separately from redacted monitoring logs.
- Completed top-level steps are checkpointed before dependent work starts and can be reused when retrying failed or interrupted runs after restart. A child-process crash test verifies this with a completed HTTP write.
- Cache keys include local model/knowledge/credential/environment state and skip declared side effects.
- SQL values use bound parameters, including mixed explicit/template MySQL placeholders.
- S3 moves verify copy completion, including embedded HTTP 200 errors, before deleting the source.
- Encrypted backups restore into a separate workspace and validate it without running schedules.
- Local defaults bound active runs, queues and per-run concurrency; owners can tune them.

These are concrete design choices, not measured claims that Jasmine is faster or more accurate than another product. [Engine benchmarks](BENCHMARKS.md) compare Jasmine configurations with simulated model latency.

## Compare deployed flows

The comparison runner calls only existing, deployed flows. Prepare equivalent flows on both systems first. Each case specifies the payload, the two flow ids, an expected status, optional expected output and explicitly ignored JSON pointers or numeric tolerance.

```bash
REFERENCE_ENDPOINT=https://your-reference/graphql \
REFERENCE_API_KEY=your-reference-key \
JASMINE_ENDPOINT=http://127.0.0.1:8787/graphql \
npm run parity:compare -- examples/parity-manifest.json comparison-report.json
```

Replace the placeholder ids in the manifest. The default GraphQL contract uses `executeWorkflow` and `checkStatus`; `reference`/`jasmine` configuration can override `executeQuery`, `statusQuery`, `executeResultPath` and `statusResultPath` for another schema. Variable names remain `workflowId`, `payload` and `requestId`. Output projections use JSON pointers, such as `referenceOutputPath: "/answer"`.

A report contains statuses, mismatched paths, result hashes and timings; it omits raw output and API keys. Exit code 1 means at least one case failed. Failure is also reported when both systems agree but violate a supplied expected output. The runner is tested against local deployed flows; **no live reference comparison has been performed in this environment**.

Model text should usually be checked with a dedicated semantic evaluation rather than exact string matching. Use deterministic fixtures for branch/loop/schema/error tests, and controlled service accounts for write operations. A passing report certifies only its named cases, configuration and tested versions.

## Work remaining before an equivalence claim

Full equivalence needs a pinned reference release, representative exported flows and schemas, complete action-level contracts, live account/database tests, browser acceptance tests, and side-by-side results for retrieval, document extraction and model quality. The partial/absent rows above also require implementation or explicit agreement that their scope is excluded. Managed edge, collaboration, advanced document intelligence and comprehensive connector actions are material remaining differences.
