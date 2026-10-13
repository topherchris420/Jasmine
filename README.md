# lamatic-engine

A private reference rebuild of a Lamatic-style flow backend: import → compile → deploy → execute → trace. It matches Lamatic's **public** contract (Studio export format, node type names and fields, `{{node.output.path}}` references, `executeWorkflow` / `checkStatus`, status values, log codes). The internals are an independent design; no Lamatic source code was used or seen.

## Quick start

```bash
npm install
npm test                 # 56 tests (vitest + fast-check)
npm run typecheck
npm run bench            # ~2 min; writes bench/results/latest.json
npm run serve            # GraphQL on http://localhost:8787/graphql (mock LLM by default)
```

Server environment variables:

| Variable | Effect |
|---|---|
| `LLM_PROVIDER=anthropic` | Use Claude through `@anthropic-ai/sdk` instead of the mock |
| `DEFAULT_MODEL` | Model used when a node doesn't name one (default `claude-opus-5-5`) |
| `LAMATIC_API_KEY`, `LAMATIC_PROJECT_ID` | Require `Authorization: Bearer …` and `x-project-id` (403 on mismatch) |
| `FLOWS_DIR` | Deploy every `*.json` in the folder on boot |
| `PORT` | Listen port (default 8787) |

When the Anthropic provider is on, it requests server-side refusal fallbacks (`fallbacks: "default"`) for models that support them. Set `refusalFallback: false` in code to turn this off.

## Layout

| Path | What it does |
|---|---|
| `src/flow/import.ts` | Studio export → engine definition (drops placeholders, maps condition branches, imports apiNode retries) |
| `src/flow/compile.ts` | Validation + execution plan (cycles, reachability, references, loops, branches) |
| `src/flow/template.ts` | `{{ref}}` paths, parse-then-resolve JSON templates, code-safe substitution |
| `src/nodes/builtin.ts` | Triggers, response, condition, code (vm), LLM, Instructor (JSON schema), API, variables, for-loop |
| `src/runtime/executor.ts` | Ready-set scheduler, branch skipping, retries / fallback / timeouts, fail-fast cancellation, loops, retry-from-failed |
| `src/runtime/trace.ts` | Trace events with Lamatic log codes, redaction, OTel-shaped spans |
| `src/service/deployments.ts` | Content-addressed versions, compile-once cache, last-known-good, compare-and-swap, rollback |
| `src/service/runs.ts` | Realtime + async (`checkStatus`), idempotency keys, backpressure, version pinning |
| `src/api/` | GraphQL schema/resolvers and HTTP server |
| `docs/` | Architecture findings, engineering audit, benchmarks, implementation plan |

## Limits of this work

- **What the numbers measure:** benchmarks compare configurations of this engine with simulated LLM latency. They say nothing direct about Lamatic production.
- **Hypotheses, not confirmed bugs:** audit findings marked hypothesis need checking in Lamatic's repo. Each comes with a test to port.
- **Missing node types:** scraper, RAG, vector, memory, integrations, agents and batch are rejected at compile time (`UNSUPPORTED_NODE_TYPE`).
- **Code sandbox:** the code node uses `node:vm`, which is not a security boundary. Production needs isolates, as Workers provide.
- **Corpus check:** `node scripts/corpus-check.ts <folder>` runs the importer and compiler over a folder of AgentKit `flows/*.ts` exports and tallies diagnostics. It reads the files as text and never executes them. Node types the rebuild doesn't implement are stubbed, so graph-level checks still run. The tests use hand-built fixtures in the same shape.
