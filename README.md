<p align="center"><img src="public/jasmine-banner.svg" alt="Jasmine — Build visually. Think locally. Ship on your terms." width="100%"></p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24%2B-0B5D63" alt="Node.js 24 or newer">
  <img src="https://img.shields.io/badge/inference-local%20or%20hosted-0B5D63" alt="Local or hosted inference">
</p>

# Jasmine

**Your models. Your data. Your workflows.**

A model can answer a question. A workflow can do something with the answer.

Jasmine turns your models, data and tools into a working application. Build on a visual canvas. Give the model your documents, memory, and tools. Deploy the flow as an API, chatbot, search widget, webhook, or scheduled job. Open its trace and see what happened at every step.

Build with a visual canvas, start from a template, test a real request, then deploy an API or widget. Guided setup, a searchable template gallery, browser sign-in, live node traces and a workspace dashboard help you move from a blank screen to something useful.

**Host Studio on Vercel. Keep the execution engine on a persistent Node host.** Or run everything locally in one process. Connect Ollama, LM Studio, llama.cpp, vLLM, or a hosted OpenAI-compatible provider. You choose every endpoint; Jasmine never silently switches to a cloud model.

**This is the same Jasmine from [R.A.I.N. Lab](https://github.com/topherchris420/james_library): its Hardware Architect, expressed here as a standalone local AI workflow platform.** Her question—*Can we actually build this?*—becomes the purpose of the software: turn an idea into a workflow you can run, inspect, and improve.

[Deploy on Vercel](docs/VERCEL.md) · [Get started](#get-started) · [Jasmine in R.A.I.N. Lab](#jasmine-in-rain-lab) · [Explore the platform](#one-workspace-from-idea-to-execution) · [Call a flow](#give-your-application-an-api) · [Feature verification](docs/PARITY.md) · [Integration setup](docs/INTEGRATIONS.md)

## Jasmine in R.A.I.N. Lab

In Vers3Dynamics' R.A.I.N. Lab, **James, Jasmine, Luca, and Elena** bring distinct perspectives to a shared research question. Jasmine is the **Hardware Architect**: pragmatic, skeptical of impractical claims, and attentive to energy requirements, material constraints, and the gap between a compelling theory and a working implementation. Her [lab identity and principles](https://github.com/topherchris420/james_library/blob/main/JASMINE_SOUL.md) define that role.

This repository carries that same Jasmine into a tool people can use. The lab's feasibility perspective becomes a practical design commitment: connect the models your hardware can run, make each step visible, test a workflow before deploying it, and keep the execution record available for inspection. **From “Can we build it?” to “Run it and see.”**

Explore the [R.A.I.N. research environment](https://github.com/topherchris420/james_library) and the [simulated worlds that house the lab](https://github.com/topherchris420/lop-nur-twin). Jasmine can also be used independently for your own applications, documents, and automations.

## Host on Vercel

The repository includes the frontend build, API gateway and routing configuration. **A separate persistent runtime is required**; Vercel alone does not run Jasmine’s SQLite workspace, scheduler or background jobs.

| Component | Where it runs |
| --- | --- |
| Studio, templates, onboarding and static widgets | Vercel |
| Streaming gateway, cookie forwarding and API routing | Vercel Function |
| Flow engine, models/integrations, jobs and schedules | Persistent Node.js 24+ host |
| Drafts, SQLite databases, uploads and encryption key | Runtime’s persistent volume |

1. Deploy the repository’s Dockerfile on a persistent host and mount `/data`.
2. Set `JASMINE_API_KEY`, `JASMINE_GATEWAY_SECRET` and the canonical HTTPS `PUBLIC_URL` on that runtime.
3. Import this repository into Vercel, using branch **master**. Set `JASMINE_RUNTIME_URL` and the matching `JASMINE_GATEWAY_SECRET` there. The checked-in configuration handles the build.
4. Open Studio, sign in with your workspace access key, and follow **Getting started**.

[Complete Vercel instructions, environment variables and troubleshooting →](docs/VERCEL.md)

This release supports **one trusted workspace per runtime**. Browser sessions are HttpOnly, expire after seven days, and are invalidated when their underlying admin key is revoked. Public self-registration, separate customer organizations, billing and distributed autoscaling are not included. These are concrete next steps toward a managed platform; the current release does not claim complete Lamatic parity.

## Get started

Requires **Node.js 24+**. Start a local model server, then start Jasmine:

```bash
git clone https://github.com/topherchris420/Jasmine.git
cd Jasmine
npm ci
npm start
```

Open **[localhost:8787](http://127.0.0.1:8787)** and follow **Getting started**. Choose **Your First API** to test and deploy a real workflow without a model. For a chatbot, connect a model and open **Getting Started: Chat Assistant**. Its endpoints and embed code appear in **Deployments** after you deploy it.

For Ollama, pull a chat model and a separate embedding model:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

When running locally, Jasmine detects Ollama on port **11434** and LM Studio on **1234** on first boot. With LM Studio, load a model and start its API server in the Developer tab. Manage connection settings, model aliases, and defaults in **Models**.

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
| **Model connections** | Native Ollama and local or hosted OpenAI-compatible APIs. Per-node models, streaming text, tools, structured JSON, embeddings, and vision when the selected model supports them. |
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

Open **Templates** to search and filter the gallery, or choose **Flows → Create flow**:

- **Your First API:** a working JSON endpoint with no model or external credentials required.

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

Drafts survive restart. Deployed versions and rollback history live in SQLite. Knowledge collections, model connections, credentials, chat sessions, run logs, feedback and alerts are persisted locally. Browser sessions and API keys are stored as hashes; credentials, project secrets, exact execution records and cached results are encrypted with AES-256-GCM. Completed idempotent responses and failed-run retry state survive restart. Completed top-level steps are checkpointed before dependent work starts. Interrupted runs are marked failed and can be retried explicitly using those saved steps.

Configuration is managed in Studio. Environment variables seed the initial setup:

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Listen address; defaults to `127.0.0.1:8787`. |
| `JASMINE_DATA_DIR` | Persistent workspace directory; defaults to `.jasmine`. |
| `JASMINE_API_KEY` | Admin API key; set before exposing the server beyond localhost. |
| `PUBLIC_URL` | Canonical HTTPS Studio origin for sessions and generated links when hosted. |
| `JASMINE_GATEWAY_SECRET` | Require this shared secret on runtime requests in Vercel gateway mode. |
| `JASMINE_RUNTIME_URL` | Vercel-only HTTPS origin of the persistent engine; see [deployment guide](docs/VERCEL.md). |
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

After the first connection is created, edit model settings in **Models**. **Settings → Encrypted backup and restore** exports a portable encrypted backup. For larger workspaces, stop Jasmine and back up the data directory and its encryption key together. Use one running Jasmine process per data directory.

## Built to be inspected

```bash
npm run build:vercel  # static Studio build; no runtime dependencies needed
npm run verify        # typecheck, script syntax checks and the full test suite
npm run smoke:local   # requires a running local model server
(cd sdk/go && go test ./...)   # Go client, when Go is installed
```

The test suite covers browser session revocation and CSRF protection, gateway routing and streaming, onboarding and template interaction, graph compilation, branching and batching, cancellation, restart-safe retries and idempotency, model protocols, agents, retrieval, encrypted storage, OAuth fixtures, MCP scopes, feedback, real local SMTP reception, offline OCR, PDF editing, backups, SDKs and simulated Studio interactions. There is no hosted CI workflow; run `npm run verify` before you push.

Feature presence is not proof of exact behavior on another platform. The [verification matrix](docs/PARITY.md) records implementation, test evidence and remaining differences. A [comparison runner](docs/PARITY.md#compare-deployed-flows) can execute matching deployed flows against two GraphQL endpoints and report mismatches without importing or deploying anything.

| Source | Responsibility |
|---|---|
| `public/` | Workflow Studio, configuration panels, monitoring, and widgets. |
| `src/flow/`, `src/runtime/`, `src/nodes/` | Graph import, compilation, scheduling, and executable nodes. |
| `src/llm/` | Local inference protocols and model routing. |
| `src/vector/`, `src/service/knowledge.ts` | Extraction, chunking, embeddings, and retrieval. |
| `src/api/`, `sdk/` | Server APIs and application clients. |
| `src/service/`, `src/db/`, `src/integrations/` | Persistence, deployments, schedules, alerts, and service adapters. |

Jasmine is actively developing. Its vector index uses exact scans. OCR bundles English data and supports up to 50 PDF pages per node. Connected accounts use your own credentials and permissions. Deployment activates flows on your persistent server; Vercel hosts the Studio and gateway. Managed global execution infrastructure and organizational administration are not included. See [capabilities and limits](docs/CAPABILITIES.md) for the precise scope.

**Build the workflow. Keep the intelligence close. Make every step visible.**
