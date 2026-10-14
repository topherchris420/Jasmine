# Jasmine reconstruction status

The target is a private educational reconstruction of the supplied Studio application, with Jasmine identity and a local inference backend. Exact overall parity remains unverified. Original server source was not recovered.

## Observed evidence

REA was used through its installed CLI after the computer-use helper failed and the connected REA server could not reach the Windows browser. An isolated browser was opened on the user-supplied URL. The user signed in manually. Existing starter-flow navigation was inspected without intentionally changing or deploying a remote flow.

| Evidence | Observation | Boundary |
| --- | --- | --- |
| `ev_a934113ca567ff0a298f529e207f344d3788fb229861eb27064b07f731969140` | Onboarding page accessibility, structure and delivered scripts | Passive attach window; cookie overlay present; no backend code |
| `ev_0e51a1a9bbc6458f27b450b47e137c2861d72ea61504e1820e2f13ab94a89455` | Static analysis of the delivered onboarding bundle | Static relationships do not prove execution or recover server internals |
| `ev_1aadc7c7988a1552e634825a40946c6ac95ced45164f8fd64e5e4fdb9acbf1af` | Authenticated project flow-list target discovered | Browser target identity only |
| `ev_40923777c6c19253de96e6db1c5a6d4f38c774becc7ced1a94e8c6d17cb9cc3b` | Authenticated Getting Started editor and its accessibility structure | Config-panel probing timed out; form behavior beyond the observed screen remains incomplete |

Complete capture JSON, original screenshots and delivered scripts remain in a separate local recovery directory. They are excluded from this repository to avoid distributing account details, authentication-adjacent URLs or tracking scripts. Historical upstream documentation findings in the other research files are separate from these REA observations.

## Implemented and checked

- Jasmine package identity, telemetry keys, server environment variables, documentation names and current source branding.
- Onboarding and an editor shell derived from the observed layout, canvas transform, node positions and starter annotations.
- Working graph editing, notes, field/JSON configuration, import/export, undo/redo, save, deployment and asynchronous testing.
- GraphQL workflow API, cancellation, retained run history, redacted traces, logs, reports and a playground.
- Local draft snapshots with atomic replacement and revision conflict detection; last deployed definitions restored at startup.
- Request validation for malformed envelopes, oversized payloads and interrupted clients, with contained server errors.
- Code-worker termination for synchronous and post-await infinite loops, cancellation and serialization failures.
- Explicit condition-branch preservation and execution-policy preservation when editing engine definitions.

The local browser verification completed save, deploy and execution with deterministic mock responses and no page script errors. Backend tests cover storage restoration, stale writes, authenticated draft access, invalid-deploy recovery, policy import and condition mapping. The earlier local inference smoke succeeded before the user directed work away from inference testing; later verification uses mocks.

## Remaining obligations for an exact clone

| Area | Status |
| --- | --- |
| Onboarding and editor visual equality | Approximate reconstruction; simplified icons and local fonts; no pixel-equality claim |
| Node configuration/test panels | Functional local implementation; complete upstream interaction parity not verified |
| Starter templates | Getting Started reconstructed; remaining upstream templates not reproduced |
| RAG, vectors, memory, agents, integrations, batch | Not implemented; unsupported node types rejected at compile time |
| Organizations, accounts, cloud scheduling, GitHub synchronization | Local workspace adaptations; original hosted control-plane behavior not reconstructed |
| Prompt/data/connection management | Prompt inspection and local model settings present; complete upstream CRUD and ingestion absent |
| Persistence | Drafts and most recent deployed definition durable; older versions and runs currently session-only |
| Security boundary for hostile code | Worker deadline control implemented; OS/container isolation still required |
| Original backend source/equivalence | Unknown; observable API contracts and independent tests are the available evidence |

No item marked incomplete should be presented as an exact reproduction. A parity pass needs more feature-specific runtime observations and side-by-side tests, followed by implementation of the missing subsystems.
