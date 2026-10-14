<p align="center"><img src="public/jasmine-banner.svg" alt="Jasmine — Build visually. Think locally. Ship on your terms." width="100%"></p>

<p align="center">
  <a href="https://github.com/topherchris420/Jasmine/actions/workflows/ci.yml"><img src="https://github.com/topherchris420/Jasmine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Node.js-24%2B-0B5D63" alt="Node.js 24 or newer">
  <img src="https://img.shields.io/badge/inference-local-0B5D63" alt="Local inference">
</p>

# Jasmine

**Your models. Your data. Your workflows.**

A model can answer a question. A workflow can do something with the answer.

Jasmine turns local AI into a working application. Build on a visual canvas. Give the model your documents, memory, and tools. Deploy the flow as an API, chatbot, search widget, webhook, or scheduled job. Open its trace and see what happened at every step.

The builder, execution engine, knowledge stores, deployments, and monitoring run in one standalone application. Connect Ollama, LM Studio, llama.cpp, vLLM, or another compatible inference server. Open Studio without signing up. Jasmine requires no hosted AI account and makes no automatic fallback to a cloud model. External integrations make network requests when you configure and use them.

[Get started](#get-started) · [Explore the platform](#one-workspace-from-idea-to-execution) · [Call a flow](#give-your-application-an-api) · [Feature verification](docs/PARITY.md) · [Integration setup](docs/INTEGRATIONS.md)

## Get started

Requires **Node.js 24+**. Start a local model server, then start Jasmine:

```bash
git clone https://github.com/topherchris420/Jasmine.git
cd Jasmine
npm ci
npm start
```

Open **[localhost:8787](http://127.0.0.1:8787)**. Open **Getting Started**, press **Test**, and send a message. Press **Deploy** when the flow is ready; its endpoints and embed code appear in **Deployments**.

For Ollama, pull a chat model and a separate embedding model:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

Jasmine detects Ollama on port **11434** and LM Studio on **1234** on first boot. With LM Studio, load a model and start its API server in the Developer tab. Manage connection settings, model aliases, and defaults in **Models**.

To explore without downloading a model:

```bash
LLM_PROVIDER=mock npm start
```

PowerShell: `$env:LLM_PROVIDER='mock'; npm start`. Mock mode produces deterministic test responses; it does not run an AI model.

### Run with Docker

```bash
docker compose up -d
docker compose exec ollama ollama pull llama3.2
docker compose exec ollama ollama pull nomic-embed-text
```

The compose stack runs Jasmine and Ollama, persists both in named volumes, and exposes Jasmine on localhost. GPU configuration is included as an optional section in [docker-compose.yml](docker-compose.yml).

## One workspace, from idea to execution

| Build | What it does |
|---|---|
| **Visual Studio** | Connect nodes, arrange the graph, configure branches, add notes and tags, pick output references, and undo edits. Ask a local assistant about your flow or review a validated draft proposal. Test with live node events before deploying. |
| **Execution engine** | Run independent steps in parallel. Use conditions, classifiers, loops, batches, sub-flows, agents, waits, retries, timeouts, and fallbacks. Cancel runs or retry failed work after restart while reusing completed steps. |
| **Local model connections** | Native Ollama and OpenAI-compatible APIs. Per-node models, streaming text, tools, structured JSON, embeddings, and vision when the selected model supports them. |
| **Knowledge and memory** | Ingest documents and websites. Chunk and embed locally. Search with cosine similarity, BM25 keywords, or hybrid retrieval, with metadata filters. Add persistent conversation memory. |
| **Document intelligence** | Offline English OCR, word boxes, confidence, PDF figure extraction, and schema-validated extraction through a local model. Merge, split, reorder and edit PDFs, bookmarks and metadata. |
| **Integrations** | HTTP, scraping, crawling, SearXNG, RSS, Slack, Teams, Discord, Telegram, SMTP, Gmail, Notion, Airtable, GitHub, Twilio, n8n, PostgreSQL, MySQL, SQL Server, S3, MCP, Google Drive/Sheets, OneDrive, SharePoint, and Webflow. Connect Google/Microsoft accounts through your own OAuth app. |
| **Deployments** | Immutable versions, rollback, cron with time zones, incremental folder sync, scheduled source reads, signed webhooks, local inbound email, chat/search widgets, and opt-in response caching. |
| **APIs and clients** | GraphQL, REST, streaming events, API playground, inbound MCP tools, JavaScript/Python/Go clients, an optional React hook and chat component, and a management CLI. Pin versions and use durable idempotency keys. |
| **Monitoring and control** | Persistent run logs, node timelines, trace exports, latency percentiles, token reports, feedback ratings/comments, local alerts, model comparisons, and passphrase-encrypted full backups. |

### Local by design, useful beyond the canvas

Jasmine includes **74 catalog entries** with configuration forms and executable handlers. Its defaults keep concurrency modest for local hardware. Increase the limits when your model server can handle more work.

The assistant proposes changes you can inspect; it validates them before applying a draft and never deploys them automatically. Response caching skips flows with declared side effects and keys results against the model, knowledge, credentials, environment and deployed version. Durable execution records keep exact results encrypted while monitoring logs can stay redacted. Backups include the databases, files, drafts and encryption key and restore into a separate workspace.

### Start with something useful

Choose a template from **Flows → Create flow**:

- **Chat assistant:** turn a local model into a deployed chat application.
- **Knowledge Q&A:** answer from a collection of your documents with retrieved references.
- **Webpage indexing:** scrape, chunk, embed, and index a page.
- **Support router:** classify a request and route it through the appropriate branch.
- **Chat with memory:** keep context across a conversation.
- **Structured extraction:** return validated JSON instead of free-form text.
- **Research agent:** give a model tools and bounded execution steps.
- **Daily digest:** combine a schedule, RSS sources, and a model.
- **Folder ingestion:** process new or changed files from a local folder.

To use RAG, create a collection under **Context**, choose its embedding connection, and upload a document. Then select that collection in a RAG or search node. Use a learned embedding model for semantic retrieval. The built-in lexical embedding option works without a model download and is labeled separately; it does not provide learned semantic understanding.

## Give your application an API

A deployed flow is immediately callable from your local server.

```bash
curl -X POST http://127.0.0.1:8787/api/v1/flows/getting-started/execute \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: greeting-001' \
  -d '{"payload":{"chatMessage":"Hello, Jasmine."},"mode":"realtime"}'
```

Add `Authorization: Bearer <key>` when authentication is enabled. Use an **execute** key in application backends and an **admin** key for project management.

### JavaScript

```javascript
import { JasmineClient } from './sdk/jasmine.mjs';

const jasmine = new JasmineClient({
  endpoint: 'http://127.0.0.1:8787',
  apiKey: process.env.JASMINE_API_KEY,
});

const run = await jasmine.executeFlow('getting-started', {
  chatMessage: 'What can we build together?',
}, { mode: 'async', idempotencyKey: 'first-conversation' });

const finished = await jasmine.wait(run.requestId);
console.log(finished.status, finished.output);
```

`events(requestId)` is an async iterator over trace, token, progress, and completion events. The client also exposes status, cancellation, retry, and trace methods. Keep API keys in your application's backend.

### CLI, React and Go

```bash
npm run cli -- flows list
npm run cli -- flows run getting-started --json '{"chatMessage":"Hello"}'
```

Use `JASMINE_ENDPOINT` and `JASMINE_API_KEY` for another Jasmine server. The CLI also manages drafts, deployments, contexts, connections, credentials, logs and backups. [SDK examples](sdk/README.md) cover the Go client and React/Next.js integration. React is optional and is supplied by your application.

### Python

```python
from sdk.jasmine import JasmineClient

jasmine = JasmineClient()
run = jasmine.execute_flow('getting-started', {
    'chatMessage': 'Explain this workflow in one sentence.'
}, mode='async')
print(jasmine.wait(run['requestId'])['output'])
```

GraphQL is available at **`POST /graphql`**:

```graphql
mutation Run($workflowId: String!, $payload: JSON) {
  executeWorkflow(workflowId: $workflowId, payload: $payload) {
    status
    requestId
    result
    version
    error { code message }
  }
}
```

Use **API Playground** for requests and generated examples. **Deployments** provides hosted chat/search pages and drop-in widget scripts. Widget endpoints are public; configure allowed domains and avoid exposing sensitive outputs.

An MCP client can connect to **`POST /mcp`**. Deployed flows become discoverable tools with their input schemas. Execute keys can run tools; admin keys can also manage drafts, deployments and contexts. [API and trigger setup](docs/OPERATIONS.md) includes feedback, caching, mail and backup examples.

## A workspace that remembers

Drafts survive restart. Deployed versions and rollback history live in SQLite. Knowledge collections, model connections, credentials, chat sessions, run logs, feedback and alerts are persisted locally. API keys are stored as hashes; credentials, project secrets, exact execution records and cached results are encrypted with AES-256-GCM. Completed idempotent responses and failed-run retry state survive restart. Interrupted in-flight work is marked failed; it is not automatically resumed.

Configuration is managed in Studio. Environment variables seed the initial setup:

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Listen address; defaults to `127.0.0.1:8787`. |
| `JASMINE_DATA_DIR` | Persistent workspace directory; defaults to `.jasmine`. |
| `JASMINE_API_KEY` | Admin API key; set before exposing the server beyond localhost. |
| `JASMINE_PROJECT_ID` | Require a matching `x-project-id` header. |
| `JASMINE_SECRET_KEY` | Encryption key; otherwise Jasmine generates `secret.key` in the data directory. |
| `LLM_PROVIDER` | Initial connection: `ollama`, `openai`, `local`, `lmstudio`, or `mock`. |
| `LLM_BASE_URL`, `LLM_MODEL`, `EMBEDDING_MODEL` | Initial server address and model choices. |
| `LLM_API_KEY`, `LLM_JSON_MODE` | Optional model-server token and structured-output mode. |
| `FLOWS_DIR` | Deploy flow JSON files from a directory at startup. |
| `JASMINE_REALTIME_TIMEOUT_MS`, `JASMINE_ASYNC_TIMEOUT_MS` | Whole-run budgets; defaults to 2 and 20 minutes. |
| `JASMINE_MAX_CONCURRENT_RUNS`, `JASMINE_MAX_QUEUED_RUNS`, `JASMINE_NODE_CONCURRENCY` | Resource limits; defaults to 4 active runs, 128 queued runs, 2 simultaneous nodes per run. |
| `JASMINE_IP_ALLOWLIST` | Optional comma-separated IP addresses or CIDR subnets allowed to reach the server. |
| `MAIL_PORT`, `MAIL_HOST`, `MAIL_DOMAIN` | Optional inbound SMTP listener and recipient domain; host/domain default to local values. |
| `PUBLIC_URL` | Base URL for generated document/image links; otherwise `http://127.0.0.1:PORT`. |

After the first connection is created, edit model settings in **Models**. **Settings → Encrypted backup and restore** exports a portable encrypted backup. For larger workspaces, stop Jasmine and back up the data directory and its encryption key together. Use one running Jasmine process per data directory.

## Built to be inspected

```bash
npm run typecheck
npm test
npm run check:scripts
npm run smoke:local   # requires a running local model server
```

The test suite covers graph compilation, branching and batching, cancellation, restart-safe retries and idempotency, model protocols, agents, retrieval, encrypted storage, OAuth fixtures, MCP scopes, feedback, real local SMTP reception, offline OCR, PDF editing, backups, SDKs and simulated Studio interactions. CI checks Linux and Windows, tests the Go SDK, and boots the Docker image with a deterministic test provider.

Feature presence is not proof of exact behavior on another platform. The [verification matrix](docs/PARITY.md) records implementation, test evidence and remaining differences. A [comparison runner](docs/PARITY.md#compare-deployed-flows) can execute matching deployed flows against two GraphQL endpoints and report mismatches without importing or deploying anything.

| Source | Responsibility |
|---|---|
| `public/` | Workflow Studio, configuration panels, monitoring, and widgets. |
| `src/flow/`, `src/runtime/`, `src/nodes/` | Graph import, compilation, scheduling, and executable nodes. |
| `src/llm/` | Local inference protocols and model routing. |
| `src/vector/`, `src/service/knowledge.ts` | Extraction, chunking, embeddings, and retrieval. |
| `src/api/`, `sdk/` | Server APIs and application clients. |
| `src/service/`, `src/db/`, `src/integrations/` | Persistence, deployments, schedules, alerts, and service adapters. |

Jasmine is actively developing. Its vector index uses exact scans. OCR bundles English data and supports up to 50 PDF pages per node. Connected accounts use your own credentials and permissions. Deployment activates flows on your server; managed global edge infrastructure and organizational administration are not included. See [capabilities and limits](docs/CAPABILITIES.md) for the precise scope.

**Build the workflow. Keep the intelligence close. Make every step visible.**
