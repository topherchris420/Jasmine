# Jasmine on herself: self-model and knowledge

Jasmine can say who she is, what she can do on this runtime, how she has been doing and what she cannot do, and she can answer from four knowledge packs built from her own documentation and the repositories around her. Open **About Jasmine** in Studio to see all of it, or ask her in the **Ask Jasmine** chat.

## What “self-aware” means here

Jasmine keeps a **self-model**, not a mind. It has four parts:

| Part | Where it comes from |
| --- | --- |
| **Who she is** | One identity record (`src/service/identity.ts`): the R.A.I.N. Lab's Hardware Architect, whose question is “Can we actually build this?”, carried into a workflow platform. It cites the lab's `JASMINE_SOUL.md` by its sha256. |
| **What she can do here** | Measured when asked: the steps in her catalog, the kinds of application her planner builds, the templates, which models are connected and answer by default, which knowledge packs are installed. |
| **How she has been doing** | The last seven days of runs: how many succeeded, median and p95 latency, tokens, the most common failure and any ratings people gave. |
| **What she cannot do** | What stops her right now (no model, no embedding model, packs not installed, a server not reachable, frequent failures), then the limits that always hold. |

Everything except the identity is measured from the runtime at the moment you ask; nothing is remembered or imagined. She uses it to answer questions about herself accurately and to say when she cannot do something. It is not consciousness, feelings or an inner life, and she says so when asked.

## Where to find it

- **Studio → About Jasmine**: identity, the last seven days, what is connected right now (model reachability fills in a moment later), her limits and her knowledge packs.
- **The copilot**: the **About Jasmine** action in any workflow answers from the same self-model and links to whatever would let her do more.
- **The About Jasmine step** (`selfNode`): gives a workflow her self-description, with a first-person `summary` sized for a prompt. Choose how much it tells:

  | Detail | Includes | Use in |
  | --- | --- | --- |
  | Who she is | Identity only, nothing about this workspace | Anything, including public widgets |
  | Who she is and what she can do here | Adds step counts, the answering model and installed knowledge packs, without addresses or errors | Public widgets (the Ask Jasmine default) |
  | Everything | Adds workflow and collection names, run statistics and error messages | Private workflows only; readiness warns if a public widget uses it |

- **REST**: `GET /api/self?detail=identity|abilities|state` (admin key). Add `probe=true` to test each model connection and report reachability.
- **MCP**: the admin tool `jasmine_self` with `{ "detail": "state", "probe": true }`.

## Knowledge packs

A knowledge pack is a ready-made document set that installs into a knowledge collection with one action. Packs share the `jasmine-knowledge` collection by default, so one search ranks all of them together.

| Pack | Documents | Holds |
| --- | --- | --- |
| Jasmine's own documentation | generated | This README and the guides in `docs/`, who she is, every step she can run, her templates and what her planner builds. Generated from the running installation, so it always matches it. |
| R.A.I.N. Lab | 33 | The four lab perspectives (James, Jasmine, Luca and Elena), the research loop, what the lab has measured, its boundaries and how it grew out of the James Library. |
| Vers3Dynamics projects | 188 | What each of the author's 25 other public repositories says about itself. |
| openai/math catalogue | 390 | 372 research-level result families from OpenAI's `openai/math`, with summaries, abstracts, formal scope and whether each is formalized in Lean or manuscript only. |

Install them under **About Jasmine → What I know**, or with `POST /api/knowledge/packs/:id/install` (body optional: `collection`, `embeddingConnection`, `embeddingModel`). The first pack in a collection fixes its embedding model; choose a learned one such as `nomic-embed-text` to search by meaning. `GET /api/knowledge/packs` lists packs with their status (`available`, `installing` with progress, `installed`, `outdated`, `failed`), sources, caveats and license, and `DELETE /api/knowledge/packs/:id` removes one. An update indexes the new copy before removing the old one, so a failed update leaves the installed version searchable, and a failed install leaves nothing behind.

### Provenance and honesty

- Each bundled pack records the repository, commit and file hashes it was built from, and Jasmine refuses a pack whose documents no longer match its content hash.
- openai/math results were produced by an internal OpenAI model. Every result states whether the catalogue records a Lean formalization or it is manuscript only; Jasmine has not compiled any proof, and the collection's README warns that unformalized results could have issues.
- The lab's persona files define characters; their technical lines are voice, not engineering data. Project READMEs describe their projects in their own words.
- Only public, non-fork repositories are bundled. Private repositories are never copied into this public repository.
- Licenses for every source are in [`knowledge/NOTICES.md`](../knowledge/NOTICES.md). [`knowledge/README.md`](../knowledge/README.md) explains how to rebuild the packs from pinned checkouts with `scripts/build-knowledge.ts`.

## Ask Jasmine

The **Ask Jasmine** template is a chat widget that answers as Jasmine: the About Jasmine step measures her, a retrieval step searches `jasmine-knowledge`, and the model answers in her voice, citing the passages it used and saying when they do not contain the answer. It needs a chat model and the knowledge packs; its readiness checklist links to both. Deploy it like any chat workflow to get a hosted chat page and an embeddable widget.

## Limits

- Answer quality depends on the connected model. A small local model may still misread a passage; the citations let you check.
- The built-in keyword embeddings match shared words only. With them, a question's common words can pull in loosely related passages; a learned embedding model ranks by meaning.
- The bundled packs are snapshots of the commits listed in their sources. Rebuild and reinstall them to pick up later changes.
- The self-model reports what the runtime can measure. It cannot judge whether an answer was correct; ratings sent through the feedback API are the only quality signal it reports.
