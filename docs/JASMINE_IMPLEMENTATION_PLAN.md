# Implementation plan

> Historical research record retained for Jasmine. References to the original vendor describe upstream observations, not Jasmine behavior. Original vendor URLs and citations are archived in Git history; these claims have not been re-verified as part of the rebrand.

Every item starts with a short **verify** step against the real repo, because most findings are hypotheses until checked. Each item points at the rebuild's test or module to port. Finding numbers refer to `JASMINE_ENGINEERING_AUDIT.md`.

## Day 1 back on the repo (half a day)

Answer the eight known unknowns in `JASMINE_ARCHITECTURE_FINDINGS.md` §6. Most are a grep or one reading session each. Use the answers to drop items below that turn out to be non-issues.

## P0: correctness, integrity, duplicated side effects

| Item | Verify | Change | Port these tests | Effort | Done when |
|---|---|---|---|---|---|
| **F2** Side-effect-safe retries | Does the apiNode executor retry POSTs? Does it send an idempotency header? Do flow-level retries re-run successful nodes? | Mark unsafe methods `sideEffect`; only retry them when the node opts into `idempotent`; send a stable `Idempotency-Key` (request + node + iteration) that survives retry-from-failed; make one layer own retries (provider SDK `maxRetries: 0`); exponential backoff with jitter as an option | `executor.test.ts`: "never blindly retries…", "reuses completed side effects (208)"; `services.test.ts`: "retries from the failed node…" | M | A forced 503 on a POST node makes exactly 1 call without opt-in; reruns present the same key |
| **F3** Parse-then-resolve JSON templates | Find how `outputMapping`, apiNode `headers`/`body` and variables `mapping` are resolved | Use `parseJsonTemplate` + `resolveJsonTemplate` (`src/flow/template.ts`) or an equivalent | `template.test.ts`: "parses before resolving…", "reproduces the failure mode…" | S–M | An LLM output containing `"`, a newline or `", "k": v` round-trips unchanged and never adds keys |

## P1: reliability and performance

| Item | Verify | Change | Port these tests | Effort |
|---|---|---|---|---|
| **F8** Atomic deploys + last-known-good + compare-and-swap | Read the deploy pipeline: where does the "active bundle" pointer change, and what happens on build/upload failure? | Content-hash versions; build and publish before the pointer swap; CAS on the expected version; one-call rollback; pin runs (and 208 retries) to their version | `services.test.ts` deployments block (4 tests) + "pins a run…" | M |
| **F4** Branch identity on edges | Read how condition values map to edges at run time | Write `sourceHandle = condition.value`; fix stale `<cond>-<placeholder>` values on edit; compile-time `BRANCH_UNMAPPED` / `BRANCH_UNKNOWN`; migrate stored flows (run `importStudioFlow` over them and count `IMPORT_BRANCH_BY_POSITION` first) | `compile.test.ts` › "maps condition edges…" | M |
| **F1** Async client timeout ≥ server limit; idempotent `executeWorkflow` | Check the SDK `checkStatus` defaults | Derive the SDK timeout from the plan limit, or return `expiresAt` / `retryAfterMs` from `checkStatus`; accept `idempotencyKey` | `services.test.ts` › "deduplicates client retries…", "serves async flows…" | S + M |
| **F5** Execution budget for Go Back | Is there any cap today? | Per-run node-execution budget + per-target visit cap → `LOOP_LIMIT`; deploy warning when a Go Back has no exit | `executor.test.ts` › "enforces an iteration limit" (adapt) | S |
| **F10** Graph-level parallelism | How does the executor pick the next node? | Ready-set scheduler with a per-run concurrency limit, fail-fast cancellation and branch-skip propagation (`src/runtime/executor.ts` `runScope`) | `properties.test.ts` executor invariants; `executor.test.ts` scheduling block; `bench/run.ts` for before/after on the real engine | M–L |

## P2: maintainability, observability, developer experience

| Item | Change | Reference | Effort |
|---|---|---|---|
| **F6** Structured errors | `extensions.code`, `retryable`, `nodeId`, and deploy `diagnostics` on every GraphQL error; keep status codes for compatibility | `src/api/graphql.ts`, `api.test.ts` | S |
| **F7** Mutation for execution | Add `mutation executeWorkflow`; deprecate the query form; refuse GET | `typeDefs` in `src/api/graphql.ts` | S |
| **F9** Strict references | Deploy-time `UNKNOWN_REFERENCE`, `REFERENCE_NOT_UPSTREAM`, `REFERENCE_INTO_LOOP`, `CONDITIONAL_REFERENCE`; run-time `TEMPLATE_UNRESOLVED` (opt-in at first, then default for new flows) | `src/flow/compile.ts`, `compile.test.ts` | S–M |
| Run tracing | Per-node events with compatible log codes, input/output hashes, `retrySuppressed`, version; OTel-shaped spans; secret redaction; hashes rather than outputs by default | `src/runtime/trace.ts`, observability tests | M |
| Cost accounting | Count tokens on failed attempts (structured-output retries) | `InstructorLLMNode` in `src/nodes/builtin.ts` | S |
| **F11** Studio weight (frontend team) | Remove duplicate GTM / Getsitecontrol; lazy-load third parties; check Rocket Loader with React hydration; dedupe the RSC prefetch | Audit F11 | S |

## P3: optional

- **Corpus check in CI:** run the importer and compiler over every AgentKit flow on each PR (`node scripts/corpus-check.ts <folder>`). That catches the F4 and F9 classes before users hit them.
- **Property tests in CI** for scheduler invariants (`properties.test.ts`), around 2 s per run.
- **Shared library:** adopt `src/flow/template.ts` and `src/flow/compile.ts` as the single template and validation implementation for Studio (client-side lint) and the runtime (deploy gate).

## What exists today

| Artifact | Status |
|---|---|
| Rebuild (this Jasmine repository) | 18 source files; TypeScript strict, type check clean |
| Tests | 56 passing across 6 files (unit, integration, property-based with about 750 generated flows, HTTP); two safety rules checked by deliberately breaking them |
| Benchmarks | `docs/JASMINE_BENCHMARKS.md`, raw data in `bench/results/latest.json` |
| Commits / PRs | Committed locally (`git log`); not pushed anywhere. No PRs: this is a standalone rebuild, not a branch of the original vendor's repo. |
