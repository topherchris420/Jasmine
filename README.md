# Jasmine

**A self-hosted AI workflow platform that runs on local models.**

Jasmine is a standalone implementation of the Lamatic.ai platform for local AI. You build AI workflows on a visual canvas, connect them to models running on your own machine (Ollama, LM Studio, llama.cpp, vLLM and other OpenAI-compatible servers), give them knowledge through local vector databases, and deploy them as APIs, webhooks, embeddable chat and search widgets, or scheduled jobs. Every run is logged with per-node inputs, outputs, timings and token usage.

It is wire-compatible where that matters: flows exported from Lamatic Studio or AgentKit import directly, and the GraphQL `executeWorkflow` / `checkStatus` API answers the way existing Lamatic clients expect. Nothing leaves your machine unless a flow calls an external service.

## What's included

| Area | What you get |
|---|---|
| **Visual workflow builder** | Canvas with drag-and-drop nodes, branch handles, loops, sticky notes, undo/redo, auto-layout, reference picker for `{{node.output.field}}`, inline validation, autosave with conflict detection, and a Test panel that streams each node's status and output (chat UI for chat flows) |
| **Execution engine** | Parallel ready-set scheduling, conditions and classifiers, for-each loops, batches, parallel branches, waits, sub-flows, per-node retries, timeouts and fallbacks, realtime and async runs, idempotency keys, cancellation, and retry of failed runs that reuses successful steps |
| **Model connections** | Ollama (native API) and any OpenAI-compatible server, with chat, streaming, tool calling, structured JSON output, embeddings and image generation; per-node model choice; aliases that map cloud model names in imported flows (`gpt-4o`, `claude-…`) to your local models |
| **RAG and vector search** | Local vector databases (SQLite + cosine similarity) with keyword (BM25) and hybrid search, metadata filters, document ingestion from PDF, Word, PowerPoint, HTML, Markdown, web pages and whole sites, chunking controls, a search playground, and long-term chat memory stores |
| **Integrations** | HTTP API, web scraper and crawler, SearXNG web search, RSS, Slack, Microsoft Teams, Discord, Telegram, email (SMTP), Notion, Airtable, GitHub, Twilio, n8n, PostgreSQL, S3-compatible storage, MCP servers (as nodes or agent tools), data tables and file extraction. Credentials are encrypted at rest |
| **Deployment** | Immutable, content-addressed versions with one-click rollback, deploy history, schedules (cron with time zones), local folder sync, webhooks with shared-secret or HMAC signatures, and per-flow allowed domains for widgets |
| **APIs** | GraphQL (`executeWorkflow`, `checkStatus`, deploy and rollback), REST execution endpoints, server-sent events for live runs, chat/search/ask widget APIs with streaming, hosted widget pages and drop-in embed scripts, an API playground that generates cURL, JavaScript and Python |
| **Monitoring** | Run logs with filters and search, a per-run timeline (waterfall) with every node's output and events, OpenTelemetry-style trace export, reports on volume, success rate, latency percentiles, tokens by model, slowest nodes and top errors, and configurable retention |
| **Project settings** | Admin and execute API keys (shown once, stored hashed), encrypted secrets (`{{secrets.project.NAME}}`), environment variables (`{{env.NAME}}`), a prompt library, and project export |

### Nodes

| Category | Nodes |
|---|---|
| Triggers | API Request, Webhook, Chat Widget, Search Widget, Ask Widget, Schedule, Local Folder |
| AI | Generate Text, Generate Text (Vision), Generate JSON, Classifier, Supervisor Agent, Generate Image, MCP Agent |
| RAG & memory | RAG, Chunking, Vectorize, Index, Vector DB, Vector Search, Hybrid Search, Keyword Search, Memory Add, Memory Retrieve |
| Logic | Condition, Loop, Batch, Parallel Branches, Wait, End, Run Flow |
| Data | Code (JavaScript or TypeScript), Variables, Extract from File, Tables |
| Apps | API, Web Scraper, Web Crawler, Scrape & Crawl, Web Search, RSS Feed, Slack, Microsoft Teams, Discord, Telegram, Email (SMTP), Notion, Airtable, GitHub, Twilio SMS, n8n Workflow, PostgreSQL, S3 Storage |
| Responses | API Response, Chat Response, Search Response, Ask Response |

Templates to start from: chat assistant, knowledge-base Q&A (RAG), web page indexing, support router, chat with memory, structured extraction, research agent with tools, daily digest (schedule + RSS) and folder ingestion.

## Quick start

You need **Node.js 24 or newer** and a local model server.

1. Install [Ollama](https://ollama.com) and pull a chat model and an embedding model:

   ```bash
   ollama pull llama3.2
   ollama pull nomic-embed-text
   ```

   LM Studio works too: load a model and start its server (Developer tab). Jasmine finds Ollama on port 11434 and LM Studio on port 1234 automatically.

2. Start Jasmine:

   ```bash
   npm ci
   npm run serve
   ```

3. Open <http://127.0.0.1:8787>. The **Getting Started** flow is ready: open it, press **Test** and chat with your local model. Then **Deploy** it and open **Deployments** for its API, widget code and hosted chat page.

No model server yet? Run `LLM_PROVIDER=mock npm run serve` to try the Studio with deterministic echo responses.

### With Docker

```bash
docker compose up -d
docker compose exec ollama ollama pull llama3.2
docker compose exec ollama ollama pull nomic-embed-text
```

Then open <http://127.0.0.1:8787>. The compose file runs Jasmine and Ollama, keeps data in named volumes, and publishes Jasmine on localhost only. For GPU inference, uncomment the GPU section of the `ollama` service. To expose Jasmine beyond your machine, set `JASMINE_API_KEY` first.

## Calling a deployed flow

GraphQL (compatible with Lamatic clients):

```bash
curl -X POST http://127.0.0.1:8787/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JASMINE_API_KEY" \
  -d '{"query":"mutation($w:String!,$p:JSON){executeWorkflow(workflowId:$w,payload:$p){status requestId result}}","variables":{"w":"getting-started","p":{"chatMessage":"Hello"}}}'
```

REST:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/flows/getting-started/execute \
  -H "Content-Type: application/json" -d '{"payload":{"chatMessage":"Hello"}}'
```

Chat widget on any website:

```html
<script src="http://127.0.0.1:8787/widget/chat.js" data-flow-id="getting-started" defer></script>
```

Pass `mode: async` to get a `requestId` immediately and poll `checkStatus`. The Studio's **API docs** page covers authentication, webhooks (including HMAC signing), streaming, widget APIs, the admin API and error codes, and the **API Playground** generates working code for each flow.

## Importing Lamatic flows

In **Flows → Create flow → Import**, upload a Lamatic Studio export (`.json`) or an AgentKit flow file (`flows/*.ts`). To import a whole AgentKit kit, choose its folder: `@prompts/…`, `@scripts/…` and other file references are inlined. TypeScript in code nodes runs as-is (types are erased), and cloud model names map to your local models.

After import, the builder lists anything left to configure, typically a vector database to choose for RAG and indexing nodes, or credentials for an integration. Integrations that only exist as cloud OAuth apps (Google Drive, Google Sheets, OneDrive, SharePoint) are reported with a local alternative such as the Local Folder trigger.

`node scripts/corpus-check.ts <AgentKit checkout>` imports and validates every flow in a folder of kits and summarizes the diagnostics.

## Configuration

Model connections, keys, secrets and settings are managed in the Studio and stored in the data directory. Environment variables:

| Variable | Default | Effect |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address. Jasmine warns if it listens beyond loopback without an admin key |
| `JASMINE_DATA_DIR` | `.jasmine` | Database, uploaded files, flow drafts and the encryption key |
| `JASMINE_API_KEY` | none | An admin key from the environment; when set, the Studio and every API require it |
| `JASMINE_PROJECT_ID` | none | Requests that send `x-project-id` must match it |
| `JASMINE_SECRET_KEY` | generated | 32-byte key (hex or base64) that encrypts credentials and secrets; otherwise one is created in the data directory |
| `LLM_PROVIDER` | auto-detect | First-run model connection: `ollama`, `openai` (any OpenAI-compatible server; `local` and `lmstudio` are aliases) or `mock` |
| `LLM_BASE_URL` | provider default | Server URL for that connection, e.g. `http://127.0.0.1:11434` or `http://127.0.0.1:1234/v1` |
| `LLM_MODEL` / `EMBEDDING_MODEL` | first available | Default chat and embedding model for that connection |
| `LLM_API_KEY` | none | Bearer token for model servers that require one |
| `LLM_JSON_MODE` | `json_schema` | Set to `json_object` for servers without JSON-schema structured output |
| `FLOWS_DIR` | none | Deploy every flow file in this folder at startup |
| `JASMINE_REALTIME_TIMEOUT_MS` / `JASMINE_ASYNC_TIMEOUT_MS` | 120000 / 1200000 | Whole-run time limits |

The `LLM_*` variables only seed the first connection when the data directory is new; afterwards, manage connections on the **Models** page.

## Security notes

- Create an admin API key (Settings → API keys) or set `JASMINE_API_KEY` before making Jasmine reachable from other machines. Until a key exists, the corresponding API is open.
- Credentials and secrets are encrypted with AES-256-GCM. Back up `JASMINE_DATA_DIR/secret.key` (or set `JASMINE_SECRET_KEY`); without it they cannot be decrypted.
- Code nodes run in a separate worker with time and memory limits and no access to Node APIs. This protects against mistakes, not against hostile code: only let people you trust edit flows.
- Widget endpoints are public by design. Restrict them with each trigger's allowed domains and keep secrets out of flow outputs.

## Development

```bash
npm test            # unit, integration and API tests (vitest)
npm run typecheck   # tsc
npm run bench       # engine benchmarks, see docs/BENCHMARKS.md
npm run smoke:local # end-to-end check against a real local model server
```

| Path | Contents |
|---|---|
| `src/api/` | HTTP server, REST and public routes, GraphQL schema |
| `src/flow/` | Flow schema, Lamatic/AgentKit import, compiler and validation, template references |
| `src/runtime/` | Executor (scheduling, retries, loops, agents) and tracing |
| `src/nodes/` | Node implementations and the catalog the Studio renders |
| `src/llm/` | Ollama and OpenAI-compatible providers, model router |
| `src/vector/` | Vector store, keyword index and hybrid search |
| `src/service/` | Deployments, runs and logs, scheduler, knowledge ingestion, connections, credentials, keys, settings |
| `src/integrations/` | MCP client, SMTP, S3, web scraping, tables |
| `public/` | The Studio (no build step), hosted widget pages and embed scripts |
| `examples/templates/` | Flow templates |

Jasmine is an independent project and is not affiliated with Lamatic.ai.
