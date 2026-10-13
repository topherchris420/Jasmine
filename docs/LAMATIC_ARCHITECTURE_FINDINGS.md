# Lamatic architecture findings

Date: 2026-10-13. Sources: the live Studio page in an authenticated browser (read-only), Lamatic's public docs, and the public AgentKit flow exports. **No Lamatic source code was available.** Backend internals below are reconstructed from documented behaviour, not observed.

Evidence labels:

| Label | Meaning |
|---|---|
| **LIVE** | Observed in the running Studio app (2026-10-13). |
| **DOCS** | Stated in lamatic.ai/docs; quotes were re-checked against the page. |
| **EXPORT** | Seen in the public AgentKit flow files (320 flows). |
| **INFERRED** | A reasoned guess; must be confirmed in the repo. |
| **UNKNOWN** | No evidence either way. |

## 1. Control plane: Studio (LIVE)

- **Framework:** Next.js App Router, built with Turbopack (`/_next/static/immutable/chunks/turbopack-*.js`, React Server Component payloads via `__next_f` and `?_rsc=` fetches).
- **Client state:** Jotai (`__JOTAI_DEFAULT_STORE__`). Validation uses Zod (`__zod_globalRegistry`).
- **Hosting:** Vercel (`/_vercel/insights`, `/_vercel/speed-insights`, `NEXT_DEPLOYMENT_ID`) behind Cloudflare (Rocket Loader, Zaraz, RUM beacon, speculation rules).
- **Analytics and tracking:**
  - PostHog, proxied first-party at `/acknowledge-data/`. Session recording, logs, dead-click capture, surveys and web-vitals are all enabled.
  - Also loaded: GTM, Leadfeeder (two trackers), Reo.dev, Getsitecontrol, Featurebase.
- **Onboarding page data flow:** data arrives as RSC payloads. The page makes no GraphQL calls. The editor's GraphQL traffic was **not** captured; I created nothing in the workspace.

## 2. Runtime and API (DOCS)

- **Deploy:** "Deploy" compiles the flow's low-code config into a TypeScript bundle, with model parameters and credentials included, and distributes it on Cloudflare Workers. The deployed flow is locked and isolated from Studio, so config changes need a redeploy. ([deployments](https://lamatic.ai/docs/deployments), [architecture](https://lamatic.ai/docs/architecture))
- **Request API:**
  - GraphQL `POST` to the project endpoint, with `Authorization: Bearer <key>` and `x-project-id` headers.
  - `executeWorkflow` is declared as a **`query`**.
  - Responses carry `status` plus `result` (`input`, `output`, per-node `nodes`, `statusCode`, `timeTakenInSeconds`). ([graphql](https://lamatic.ai/docs/interface/graphql))
- **Run modes:**
  - The trigger's `responeType` (sic) selects `realtime` or `async`.
  - Async runs return a `requestId`; clients then poll `checkStatus` until `success`, `failed` or `error`.
  - The SDK polls every 15 s and gives up after 15 min.
- **Limits:**
  - Sync runs: ~2 min (Pro) or ~5 min (Enterprise).
  - Async runs: ~20 min (1 h in container mode).
  - Memory: 128 MB.
  - Code node: 10,000 characters; `require`, `eval` and `child_process` are blocked.
  - Flow size: ~20 nodes recommended for sync, ~50 for async.
  - Loop or batch body: 20 nodes on Starter and Pro. ([limits](https://lamatic.ai/docs/limits))
- **Node logic:**
  - Retry: max attempts with a fixed delay. No backoff or jitter is documented.
  - Fallback: config A with a timeout, then config B.
  - Parallel and A/B splits.
  - "Go Back": no built-in iteration cap; users are told to add their own safeguards. ([node logic](https://lamatic.ai/docs/nodes/node-logic))
- **Errors and log codes** ([error reference](https://lamatic.ai/docs/error-reference)):
  - An unknown flow returns HTTP 200 with `Workflow not found!` in the body.
  - A bad key returns 403 `Access Denied`; the API never returns 401.
  - Flow-level retries go up to 5, with up to 30 s between attempts.
  - Node log codes: 200 ok, 204 ok after retry, 208 skipped in a retried run, 304 branch not taken, 400 bad payload, 408 fallback after timeout, 500 failed, 509 failed and will retry.

## 3. Flow model (EXPORT + DOCS)

- **Nodes:** `{id, type: "triggerNode"|"dynamicNode", data: {nodeId: <TYPE>, trigger?, values}}`. Note that `data.nodeId` is the node *type* and `id` is the instance.
- **Edges:** `{source, target, sourceHandle, targetHandle, type}`. The edge types are:
  - `defaultEdge`: normal dependency.
  - `conditionEdge`: a branch out of a condition node.
  - `loopEdge`: closes a for-loop.
  - `responseEdge`: trigger to response; doesn't execute anything.
  - `branchEdge`, `agentClassifierEdge` and `agentLoopEdge`: also present.
- **References:**
  - Syntax: `{{<instanceId>.output.<path>}}`, with paths like `a.b`, `[2]`, `[1:4]` and `[:].key`.
  - Only upstream nodes are documented as referenceable.
- **JSON stored as strings:** these values are JSON strings that contain `{{refs}}`:
  - response `outputMapping`
  - apiNode `headers`
  - variablesNode `mapping`
  - InstructorLLMNode `schema`
  - each condition's `condition`
- **Condition branches:**
  - Each condition carries `value: "<conditionNodeId>-<targetNodeId>"`. The condition edges themselves use the generic handle `sourceHandle: "bottom"`.
  - In a public flow (`agent-reliability-audit`), both condition values name `addNode_*` placeholders, while the real condition edges point at `InstructorLLMNode_186` and `InstructorLLMNode_990`. The branch-to-edge mapping therefore can't be reliably recovered from the export (see finding F7).
- **Loops:**
  - `forLoopNode` and `forLoopEndNode` point at each other via `values.connectedTo` and are joined by two `loopEdge`s.
  - Body nodes are connected with ordinary edges.
- **Kit files:** values may reference kit files (`@prompts/x.md`, `@scripts/x.ts`, `@model-configs/x.ts`) that are resolved at build time.

## 4. Path from creation to response

| Stage | What is known | Evidence |
|---|---|---|
| Creation (Studio editor) | React-Flow-style graph held in client state (Jotai) | LIVE (state library), EXPORT (shape) |
| Serialization | Export shape above; numbers often stored as strings (`retries: "0"`) | EXPORT |
| Client validation | Not observed | UNKNOWN |
| Compilation | Low-code config compiled to a TS bundle with credentials | DOCS |
| Deployment | Cloudflare Workers, usually under a minute; GitHub sync with auto-deploy on commit | DOCS |
| Deploy atomicity, rollback, concurrent deploys | Not documented | UNKNOWN |
| Execution | Per-node logs with codes above; retry, fallback, parallel and A/B logic; loops; flow-level retries | DOCS |
| Scheduling of independent nodes (parallel or sequential) | Not documented | UNKNOWN |
| Template resolution (parse-then-resolve or splice-then-parse) | Not documented | UNKNOWN |
| Response | GraphQL `status` + `result`; async via `checkStatus` | DOCS |

## 5. How the rebuild maps onto this

```
Studio export ──importStudioFlow──► FlowDefinition ──compileFlow──► ExecutionPlan (content-addressed version)
                (src/flow/import.ts)                (src/flow/compile.ts)        │
                                                                                 ▼
GraphQL (src/api) ──► RunService (src/service/runs.ts) ──► executePlan (src/runtime/executor.ts)
  executeWorkflow       idempotency, backpressure,           ready-set scheduler, branch skip (304),
  checkStatus           async + checkStatus, retry-from-     retries (509/204), fallback (408), timeouts,
  deployFlow ─────────► DeploymentRegistry                   fail-fast cancellation, loops, traces + OTel spans
  rollbackFlow           (src/service/deployments.ts):
                         compile-once cache, last-known-good on failure, compare-and-swap, rollback
```

Node handlers (`src/nodes/builtin.ts`) use Lamatic's type names and value fields: `graphqlNode`, `webhookTriggerNode`, `chatTriggerNode`, `cronNode`, `graphqlResponseNode`, `chatResponseNode`, `conditionNode`, `codeNode`, `LLMNode`, `InstructorLLMNode`, `apiNode`, `variablesNode`, `forLoopNode`, `forLoopEndNode`. Every other type (scraper, RAG, vector, memory, integrations, agents, batch) is rejected at compile time with `UNSUPPORTED_NODE_TYPE`, rather than failing at run time.

## 6. Known unknowns (check first when back on the repo)

1. Are independent nodes executed concurrently?
2. How are `{{refs}}` inside JSON-string fields resolved? Splice-then-parse would be vulnerable to F6.
3. How are condition values mapped to outgoing edges (F7)?
4. Do `apiNode` retries and flow-level retries re-send POSTs, and is any idempotency key sent (F2)?
5. Is deploy activation atomic? Does a failed or interrupted deploy keep the previous bundle? Are concurrent deploys serialized?
6. Is a run pinned to the bundle version it started on? How does retry-from-failed (208) behave if the flow was redeployed in between?
7. What happens to an unresolved `{{ref}}`: empty string, `undefined` or an error?
8. Is there any cap on Go Back iterations or total node executions per run?
