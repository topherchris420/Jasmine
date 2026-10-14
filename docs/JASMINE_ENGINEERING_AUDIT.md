# Historical upstream engineering audit

> Historical research record retained for Jasmine. References to the original vendor describe upstream observations, not Jasmine behavior. Original vendor URLs and citations are archived in Git history; these claims have not been re-verified as part of the rebrand.

Date: 2026-10-13 · Scope: the public docs, the public AgentKit flow exports, and a read-only look at live Studio. **No access to the original vendor source code.**

## How to read this

- Each finding says what is **verified** (with its source) and what is a **hypothesis** that has to be checked in the repo.
- Every hypothesis comes with a ready-made reproduction. These are tests in this Jasmine repository that show the failure mode on a naive design and the fix on the rebuild; port them to the real engine.
- Nothing here claims the original vendor's backend has a bug I didn't observe.
- Effort: **S** ≤ 2 days, **M** ≈ 1–2 weeks, **L** > 2 weeks, all assuming repo familiarity.

## Summary

| # | Finding | Evidence | Severity if confirmed | Priority | Effort |
|---|---|---|---|---|---|
| F1 | SDK stops polling async runs after 15 min, but async runs can last ~20 min (1 h in container mode) | **Verified** (docs) | High | P1 | S |
| F2 | Retry layers (node, flow ×5, fallback, retry-from-failed) with no documented idempotency can duplicate external side effects | Layers **verified** (docs); duplication **hypothesis** | Critical | P0 (verify) | M |
| F3 | JSON-string templates (`outputMapping`, apiNode `headers`/`body`, `mapping`) break, or can be injected into, if resolved by string splicing | Format **verified** (exports); resolution **unknown** | Critical | P0 (verify) | S–M |
| F4 | Condition branches are keyed by `"<cond>-<target>"` strings that go stale; condition edges carry no branch id | **Verified** (public flow) | High | P1 | M |
| F5 | "Go Back" has no built-in iteration cap | **Verified** (docs) | High (cost) | P1 | S |
| F6 | Errors are message strings; an unknown flow returns HTTP 200 + `Workflow not found!` | **Verified** (docs) | Medium | P2 | S |
| F7 | `executeWorkflow` is a GraphQL `query` although it has side effects | **Verified** (docs) | Medium | P2 | S |
| F8 | Deploy atomicity, last-known-good, concurrent deploys and run version-pinning are undocumented | **Unknown** | High | P1 (verify) | M |
| F9 | Unresolved `{{refs}}` behaviour is undocumented; silent `""` would send empty prompts | **Unknown** | Medium | P2 (verify) | S |
| F10 | Whether independent nodes run concurrently is undocumented; parallel scheduling measured at 4.3× (fan-out) and 2.6× (branches) p50 in the rebuild | **Unknown** for the original vendor; gain **measured** in rebuild | Medium (latency) | P1 (verify) | M–L |
| F11 | Studio onboarding ships about 6.1 MB of JS, two copies of GTM and Getsitecontrol, and a duplicate RSC prefetch | **Verified** (live) | Low–Medium | P2 (frontend team) | S |

---

## F1: Async polling gives up before async runs finish

- **Observed (docs, graphql (historical vendor documentation), limits (historical vendor documentation)):**
  - The SDK's `checkStatus` defaults to "a 15 second interval and a 15 minute timeout".
  - Async runs are allowed "up to ~20 minutes", or 1 h in container mode.
- **Impact:**
  - Any async run lasting 15–20 min (or up to 60 min in containers) looks like a client timeout even though it is still running, and it may then succeed unseen.
  - A caller that retries `executeWorkflow` starts a **second** run, duplicating LLM spend and side effects (compounded by F2).
- **Root cause:** the client default was never derived from the server limit.
- **Fix:**
  1. Set the SDK timeout to at least the plan's async limit, or better, have the server return `expiresAt` / `retryAfterMs` in `checkStatus` so the client follows the server.
  2. Accept an idempotency key on `executeWorkflow` so a client retry returns the existing `requestId`.
- **Rebuild reference:**
  - `RunService.executeWorkflow({ idempotencyKey })`: same key and same payload return the same request; a different payload returns `CONFLICT`.
  - Test: `test/services.test.ts` › "deduplicates client retries with an idempotency key".
- **Regression risk:** low. These are additive API fields.

## F2: Retries can repeat external side effects

- **Observed (docs):**
  - Node Retry uses "Max Retry Attempts" plus a fixed delay, with no backoff or jitter documented.
  - Flow-level retries go "up to 5, with a delay of up to 30 seconds".
  - Fallback runs config B after config A times out.
  - Retry-from-failed exists (log codes 509, 204, 208).
  - `apiNode` exports carry `retries` / `retry_delay`.
  - Idempotency is not mentioned anywhere in the node-logic docs.
- **Hypothesis:** an `apiNode` POST (or a flow-level retry of a flow containing one) that times out after the upstream has committed gets re-sent, causing double charges, duplicate emails or duplicate tickets. If the provider client also retries internally, the layers multiply, up to 3 × 3 × 6 = 54 calls per node (arithmetic in `JASMINE_BENCHMARKS.md` §5).
- **Fix, as implemented in the rebuild:**
  - **Classify:** each node type declares `sideEffect` (POST/PUT/PATCH/DELETE) and `idempotent`.
  - **Gate:** a retryable error on a non-idempotent side-effect node is **not** retried. The trace records `retrySuppressed: "side-effect-not-idempotent"`.
  - **Stable key:** an `Idempotency-Key` derived from (original request, node, loop iteration) is sent on unsafe methods. It is identical across attempts **and** across retry-from-failed reruns, so upstreams can dedupe.
  - **Reuse:** retry-from-failed reuses completed nodes (208) instead of re-running them.
  - **One retry layer:** the LLM SDK runs with `maxRetries: 0`; measured result is 3 provider calls for 3 attempts.
- **Reproduction:** `test/executor.test.ts` › "never blindly retries a non-idempotent side effect" and "reuses completed side effects (208)", plus `test/services.test.ts` › "retries from the failed node … without repeating completed side effects". I checked these tests can fail: turning the side-effect gate off makes the first one fail.
- **Verify in repo:** does the apiNode executor retry POSTs? Does it send any idempotency header? Do flow-level retries re-run already-successful nodes?
- **Regression risk:** medium. Flows that currently "work" by retrying POSTs would see fewer retries. Ship behind a per-node `idempotent: true` opt-in and announce it.

## F3: JSON templates resolved by string splicing

- **Observed (exports):** response mappings are JSON **strings** with references inside quoted values, for example `"outputMapping": "{\n  \"summary\": \"{{LLMNode_160.output.generatedResponse}}\"\n}"`. The same goes for apiNode `headers`, variablesNode `mapping` and condition JSON.
- **Hypothesis:** if the runtime substitutes values into the text and then calls `JSON.parse`:
  - any LLM output containing `"` or a newline makes the response fail;
  - text that a user or model controls can add keys. `ok", "isAdmin": true, "z": "` turns `{"summary": "…"}` into an object with `isAdmin: true`. The same applies to apiNode bodies sent to third parties.
- **Fix:** parse the template first, then resolve references inside the parsed structure. References outside strings (`{"n": {{x.output.count}}}`) are swapped for sentinels before parsing, so they keep their raw type. Resolved values can then never change the JSON structure.
- **Reproduction:** `test/template.test.ts` › "reproduces the failure mode of resolve-then-parse" shows both the parse failure and the key injection on the naive approach, and the safe result from `resolveJsonTemplate`.
- **Verify in repo:** find where `outputMapping` / apiNode `body` are resolved and check the order of parsing and substitution.
- **Regression risk:** low. Output differs only for inputs that previously failed or were corrupted.

## F4: Condition branches keyed by stale strings

- **Observed (public flow `kits/agent-reliability-audit`):**
  - The condition values are `conditionNode_230-addNode_447` and `conditionNode_230-addNode_869`, both naming UI placeholders.
  - The real `conditionEdge`s go to `InstructorLLMNode_186` and `InstructorLLMNode_990`, with the generic `sourceHandle: "bottom"`.
  - Nothing on an edge says which condition it belongs to.
- **Impact:** the runtime has to guess:
  - **Matching by suffix** means these branches never fire: a silent no-op, a missing output or "no response".
  - **Matching by position** means reordering or re-adding an edge in Studio silently swaps the if and else branches.
- **Fix:**
  1. Store the condition id on the edge (`sourceHandle = condition.value`) and rewrite stale values when a placeholder is replaced.
  2. At deploy, reject any condition edge that doesn't map to exactly one condition.
  3. Migrate existing flows.
- **Rebuild reference:** the importer matches by suffix, then by position with an `IMPORT_BRANCH_BY_POSITION` warning. The compiler rejects `BRANCH_UNMAPPED`, `BRANCH_UNKNOWN` and `BRANCH_ON_NON_CONDITION`. Test: `test/compile.test.ts` › "maps condition edges by value suffix, falling back to position with a warning".
- **Regression risk:** medium. This needs a data migration. Run the rebuild's importer over all stored flows first to size the problem.

## F5: Unbounded "Go Back" loops

- **Observed (docs):** "Be careful to avoid infinite loops … set maximum iteration limits". The engine provides no cap; the only bound is the run timeout of 2–20 minutes.
- **Impact:** a condition that never turns false burns LLM calls until the run times out.
- **Fix:**
  - Enforce a per-run node-execution budget and a per-target revisit cap (default around 25), returning a `LOOP_LIMIT` error.
  - At deploy, warn on a Go Back that has no exit branch.
- **Rebuild reference:** for-loops are capped (`maxLoopIterations`, error `LOOP_LIMIT`, test "enforces an iteration limit"). Go Back isn't implemented in the rebuild; the same budget applies.

## F6: Error contract is message strings

- **Observed (docs):** an unknown flow returns HTTP 200 with `Workflow not found!`, and a bad key returns 403 `{"errors":[{"message":"Access Denied"}]}`. Clients have to string-match.
- **Fix:** keep the status codes for compatibility, but add `extensions: { code, retryable, nodeId }` to every GraphQL error, and `diagnostics` for deploy failures.
- **Rebuild reference:** `src/api/graphql.ts`. Test: `test/api.test.ts` › "returns machine-readable error codes".

## F7: `executeWorkflow` is a query

- **Observed (docs):** `query ExecuteWorkflow(...)`.
- **Impact:** GraphQL-over-HTTP allows queries over GET. Caches, CDNs, persisted-query layers and client libraries treat queries as safe to cache, dedupe and retry, which is wrong for something that spends money and calls APIs.
- **Fix:** add `mutation executeWorkflow` with the same arguments, keep the query as a deprecated alias, and refuse GET for it.
- **Rebuild reference:** both are exposed. Test: "exposes execution as a mutation too".

## F8: Deploy semantics undocumented

- **Unknown:** whether activation is atomic; whether a failed build or upload keeps the previous bundle; what two concurrent deploys do (for example a GitHub auto-deploy racing a Studio deploy); and whether in-flight runs and retry-from-failed are pinned to their version.
- **Rebuild design:**
  - Versions are content hashes, compiled once.
  - Compile and publish happen **before** a compare-and-swap of the active pointer.
  - A deploy that started on an older base gets `CONFLICT` instead of overwriting a newer deploy.
  - Rollback is instant.
  - Runs and retries are pinned to the version they started on.
- **Tests:** `test/services.test.ts` › "keeps the last known-good version…", "refuses to let a slower, older deploy overwrite a newer one", "pins a run to the version it started on…", "supports compare-and-swap deploys and instant rollback".

## F9: Unresolved references

- **Unknown:** what `{{node.output.missing}}` becomes.
- **Rebuild:**
  - **Compile time:** `UNKNOWN_REFERENCE`, `REFERENCE_NOT_UPSTREAM` (the value would depend on timing), `REFERENCE_INTO_LOOP`, and a `CONDITIONAL_REFERENCE` warning (the referenced node may be skipped by a branch).
  - **Run time:** strict mode fails with `TEMPLATE_UNRESOLVED`, while condition operands stay lenient so emptiness checks still work.
- **Tests:** `test/compile.test.ts` (reference validation), and "fails loudly on a reference that resolves to nothing".

## F10: Parallel execution of independent nodes

- **Unknown for the original vendor.** The docs describe a "Parallel" *logic step* (A and B on one node), not graph-level concurrency.
- **Measured in the rebuild:**
  - Ready-set scheduling cuts p50 from 201.8 to 46.5 ms (4.3×) on a 6-way fan-out and from 201.2 to 77.4 ms (2.6×) on 3 independent pipelines, with no change on pure chains.
  - Under 50 concurrent clients, throughput goes from 228.6 to 859.7 runs/s.
- **Correctness (property-tested over about 750 random flows):** every node runs at most once, runs exactly when an active edge reaches it, starts after all its predecessors finish, and never exceeds the concurrency limit.

## F11: Studio front-end weight (for the frontend team)

- **Observed (live, onboarding page, 2026-10-13):**
  - 156 resources and about 6.1 MB of first-party JS once decoded (2.9 MB transferred).
  - DOMContentLoaded at 837 ms, load at 2.8 s.
  - `gtm.js` and `l.getsitecontrol.com/8wl9lnqw.js` are each injected twice.
  - `/onboarding/book-demo/schedule-call` is prefetched twice with different `_rsc` keys.
  - Cloudflare Rocket Loader is active on a React app.
- **Fix:**
  - Remove the duplicate tags (probably GTM firing a tag that is also hard-coded).
  - Lazy-load the third-party scripts after interaction.
  - Check that Rocket Loader isn't reordering hydration.
- **Measurement:** I have the before numbers only. The after numbers need a change to their site.

## Observability: what an engineer can answer with the rebuild's trace

| Question | Where |
|---|---|
| Which node failed? | `result.error.nodeId`, `node.failed` event, OTel span status |
| What input reached it? | `inputHash` (hash of config + referenced upstream outputs); optional redacted preview (`traceOutputs: "preview"`) |
| Which retries happened? | `node.retry` events (509) with attempt, delay and error; `retrySuppressed` when a retry was blocked |
| Was the output validated? | `InstructorLLMNode` → `OUTPUT_SCHEMA` errors; token usage counted for failed attempts too |
| Did a side effect complete? | `Idempotency-Key` per request, node and iteration; 208 reuse in retried runs |
| What changed between runs? | Compare `inputHash` / `outputHash` per node, plus `version` |
| Which deployment ran? | `result.version` and the `jasmine.flow_version` span attribute |

Secrets are redacted by key name (`apiKey`, `token`, `authorization`…) and by value pattern (`sk-…`, `Bearer …`, JWTs). By default traces store hashes, not outputs. Test: "keeps secrets out of traces".
