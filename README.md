# Jasmine

**Build a flow. Run it locally. Understand every step.**

Jasmine is an independent educational flow engine for cybersecurity students: import, compile, deploy, execute, and trace. It implements a subset of the original Studio export and API contracts (node type names and fields, `{{node.output.path}}` references, `executeWorkflow` / `checkStatus`, status values, log codes). This is a rebuild from observable behavior and public formats; no original vendor source code was recovered or used.

## Quick start

Requires **Node.js 24 or newer**. Clone this repository and open a terminal in its directory.

```bash
npm ci
npm test                 # backend regression and property tests
npm run typecheck
npm run bench            # ~2 min; writes bench/results/latest.json
npm run serve            # Studio on http://127.0.0.1:8787; GraphQL at /graphql
```

Open [Studio](http://127.0.0.1:8787/studio), select **Getting Started**, and use **Test** to inspect a run. For a demo without a model server, set `LLM_PROVIDER=mock` before starting Jasmine (`$env:LLM_PROVIDER = 'mock'` in PowerShell, or `LLM_PROVIDER=mock npm run serve` in bash).

Server environment variables:

| Variable | Effect |
|---|---|
| `LLM_PROVIDER` | `local` by default; `mock` for deterministic demos; `anthropic` only when explicitly chosen |
| `LLM_MODEL` | Pin a local model identifier; otherwise discover a chat model from `/v1/models` |
| `JASMINE_API_KEY`, `JASMINE_PROJECT_ID` | Require `Authorization: Bearer …` and `x-project-id` (403 on mismatch) |
| `FLOWS_DIR` | Deploy every `*.json` in the folder on boot |
| `PORT` | Listen port (default 8787) |
| `HOST` | Listen address (default `127.0.0.1`) |
| `JASMINE_DATA_DIR` | Draft and active-deployment storage (default `.jasmine`) |

When the Anthropic provider is on, it requests server-side refusal fallbacks (`fallbacks: "default"`) for models that support them. Set `refusalFallback: false` in code to turn this off.

## Local AI models

Jasmine uses an OpenAI-compatible local inference server by default. Start the server in LM Studio's Developer tab and load a chat model, then run `npm run serve`. The default API base is `http://127.0.0.1:1234/v1`. Jasmine discovers the first non-embedding model advertised by `/models` when `LLM_MODEL` is unset; the server controls whether advertised models are already loaded or load on demand. Set `LLM_MODEL` to choose reliably when multiple models are available.

For PowerShell:

```powershell
$env:LLM_PROVIDER = 'local'
$env:LLM_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:LLM_MODEL = 'gemma-4-e4b-it' # use an identifier from your local server
npm run serve
```

Imported flow provider/model labels are mapped to the configured local backend and local model. No cloud model is used as a fallback. A missing server or model produces an explicit run error. To use deterministic test responses instead, set `LLM_PROVIDER=mock`.

Optional `LLM_API_KEY` adds bearer authentication to the local server. `LLM_BASE_URL` can point at another compatible inference server. Requests default to 1,024 output tokens; individual nodes may supply `maxTokens`. Instructor nodes request strict JSON schema output; for servers that support only JSON object mode, set `LLM_JSON_MODE=json_object`. Jasmine still validates Instructor outputs against the schema. Model calls propagate cancellation and leave retries to the engine's node policy.

Protocol references: [LM Studio chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions) and [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output).

## Layout

| Path | What it does |
|---|---|
| `src/flow/import.ts` | Studio export → engine definition (drops placeholders, maps condition branches, imports apiNode retries) |
| `src/flow/compile.ts` | Validation + execution plan (cycles, reachability, references, loops, branches) |
| `src/flow/template.ts` | `{{ref}}` paths, parse-then-resolve JSON templates, code-safe substitution |
| `src/nodes/builtin.ts` | Triggers, response, condition, code, LLM, Instructor (JSON schema), API, variables, for-loop |
| `src/nodes/code-worker-runner.ts` | Terminates code-node work on timeout or cancellation, including loops after `await` |
| `src/runtime/executor.ts` | Ready-set scheduler, branch skipping, retries / fallback / timeouts, fail-fast cancellation, loops, retry-from-failed |
| `src/runtime/trace.ts` | Trace events with compatible log codes, redaction, OTel-shaped spans |
| `src/service/deployments.ts` | Content-addressed versions, compile-once cache, last-known-good, compare-and-swap, rollback |
| `src/service/runs.ts` | Realtime + async (`checkStatus`), idempotency keys, backpressure, version pinning |
| `src/service/workspace.ts` | Atomic local draft snapshots and revision conflict checks |
| `src/api/` | GraphQL schema/resolvers and HTTP server |
| `public/` | Onboarding, graph editor, node configuration, testing, logs, reports and API playground |
| `docs/` | Architecture findings, engineering audit, benchmarks, implementation plan |

## Limits of this work

- **What the numbers measure:** benchmarks compare configurations of this engine with simulated LLM latency. They say nothing direct about the original hosted service.
- **Hypotheses, not confirmed bugs:** audit findings marked hypothesis need checking in the original vendor's implementation. Each comes with a test to port.
- **Missing node types:** scraper, RAG, vector, memory, integrations, agents and batch are rejected at compile time (`UNSUPPORTED_NODE_TYPE`).
- **Code execution:** each code node runs in a disposable worker with a deadline and an empty environment. Worker threads and `node:vm` provide deadline control, not an OS security boundary; hostile student code requires a separate container or OS sandbox.
- **Parity:** this is a working reconstruction, not a verified exact clone. See [reconstruction status](docs/RECONSTRUCTION_STATUS.md) for observed evidence and remaining gaps.
- **Persistence:** Studio drafts and the last deployed definition survive restart. Run history and older rollback versions currently remain in memory.
- **Corpus check:** `node scripts/corpus-check.ts <folder>` runs the importer and compiler over a folder of AgentKit `flows/*.ts` exports and tallies diagnostics. It reads the files as text and never executes them. Node types the rebuild doesn't implement are stubbed, so graph-level checks still run. The tests use hand-built fixtures in the same shape.

## Studio workflow

Open `/studio` and choose **Edit** on Getting Started. Double-clicking a flow row also opens it. The canvas supports node selection, drag, pan, zoom, fit, notes and undo/redo. Select a node to edit its fields or JSON values. Connect an output circle to an input circle; double-click a connection to remove it. Use **Create** to add a draft or import a Studio JSON export, and **Config** to inspect or export it.

**Save** persists the draft. **Deploy** compiles and activates it. **Test** runs the current draft asynchronously and displays output, node status, timing and redacted trace events; **Cancel** stops a pending run. Logs and Reports show retained execution results. The API Playground uses the same GraphQL backend. `/docs` documents the local API.

Draft writes reject stale revisions from another tab rather than overwriting them. Invalid deployment keeps the last valid version active. Jasmine exports preserve explicit condition branches in `edge.branch` and engine execution policy in `data.engineLogic`; these are local extensions to the upstream format.

## Reliability and development

Draft saves capture their input when requested, serialize writes, and expose the new revision only after the snapshot is committed. Failed writes preserve the previous in-memory state and attempt to remove temporary files. Snapshot loading validates every entry before replacing the current workspace and rejects duplicate flow IDs. Use one Jasmine process per data directory; the write queue is process-local, not a cross-process lock.

Run cancellation honors signals that were aborted before submission and removes caller signal listeners when execution settles. The regression suite covers these cases alongside failed writes, restart recovery, conflicting edits, compilation, execution, and API behavior.

```bash
npm run typecheck
npm test
```

GitHub Actions runs both checks on Node.js 24 on Linux and Windows for pushes and pull requests. Benchmarks remain a separate, opt-in command; local correctness checks do not require a running model or paid provider.

