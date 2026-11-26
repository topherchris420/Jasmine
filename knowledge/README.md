# Jasmine's knowledge packs

Knowledge packs are ready-made document sets that Jasmine can install into a knowledge collection with one action, under **About Jasmine → What I know** (or `POST /api/knowledge/packs/:id/install`). Installed packs share the `jasmine-knowledge` collection by default, so one search ranks all of them together, and any workflow can search them like a collection of your own documents. The **Ask Jasmine** template answers from them.

Nothing is installed until you ask: embedding about 700 documents takes a minute or two with a local embedding model.

| Pack | Documents | What it holds | Source |
| --- | --- | --- | --- |
| `jasmine-docs` | generated | Jasmine's README and guides, who she is, every step she can run, her templates and what her planner builds | This installation; regenerated when Jasmine is updated |
| `rain-lab` | 33 | The four R.A.I.N. Lab perspectives (James, Jasmine, Luca and Elena), how the lab runs research, what it has measured, its boundaries and its history | [`topherchris420/lop-nur-twin`](https://github.com/topherchris420/lop-nur-twin) and [`topherchris420/james_library`](https://github.com/topherchris420/james_library) |
| `vers3dynamics-projects` | 188 | What each of the author's other public repositories says about itself: purpose, how it works, how to run it, evidence and limits | 25 public, non-fork repositories of [`topherchris420`](https://github.com/topherchris420) |
| `openai-math` | 393 | 375 result families from OpenAI's [`openai/math`](https://github.com/openai/math) in 17 disciplines, with summaries, abstracts, Lean formal scope and whether the catalogue marks each as formalized, manuscript only, or unverified | `openai/math`, through the pinned index in `lop-nur-twin` |

Every bundled pack records the commit and file hashes it was built from (`sources`), its caveats and its license. Jasmine checks each pack's content hash when she loads it and refuses a pack that was edited by hand.

### November 24 OpenAI math snapshot

The refreshed pack supersedes the October 6 snapshot and no longer indexes the three manuscripts in [OpenAI’s October 7 withdrawal notice](https://github.com/openai/math/blob/3344da59991ed94f9ba711217b29c1d760badfa6/history.md#october-7-2026). Family 032 links to [the remaining Lean scope](https://github.com/openai/math/blob/3344da59991ed94f9ba711217b29c1d760badfa6/lean/docs/032.md), which is limited to complex CM abelian varieties.

Updating Jasmine’s files does not replace an already installed pack. In Studio, go to **About Jasmine → What I know**, choose **Update available** for `openai-math`, and wait for indexing to finish. Until it does, the old results remain searchable.

## How Jasmine uses them honestly

- **Model-produced mathematics.** The `openai/math` results were produced by an internal OpenAI model. Each result distinguishes a catalogued Lean formalization, a manuscript-only entry, or metadata the index could not verify. Jasmine has not compiled any proof, and a comparator configuration is not proof of everything in a catalogue row.
- **Personas are characters.** The lab's SOUL files define characters for meetings. Their technical lines are voice, not verified engineering data.
- **READMEs speak for their projects.** A project's README describes it in its own words; it is not independent evidence that a method works.
- **Public sources only.** Only public, non-fork repositories are bundled. Private repositories are never copied into this public one.

## Rebuilding the bundled packs

The packs are built from local checkouts, read as text (nothing in them is imported or executed), and the output is deterministic: the same commits give byte-identical files.

```bash
git clone --depth 1 https://github.com/topherchris420/lop-nur-twin ../lop-nur-twin
git clone --depth 1 https://github.com/topherchris420/james_library ../james_library
# One checkout per project repository, named like the repository; a README-only sparse checkout is enough.
node scripts/build-knowledge.ts --lop-nur-twin ../lop-nur-twin --james-library ../james_library --repos ../checkouts
node scripts/build-knowledge.ts --lop-nur-twin ../lop-nur-twin --james-library ../james_library --repos ../checkouts --check
```

`--check` exits with an error when a pack on disk differs from a fresh build. After rebuilding, reinstall the packs in Studio; installed packs whose content changed show **Update available**.

Refresh only the math pack and its notice from the Lop Nur Twin commit listed in its `sources`:

```bash
git -C ../lop-nur-twin fetch origin 3bdd734f40febee09a11ac63814d252acca2ad04
git -C ../lop-nur-twin checkout --detach FETCH_HEAD
node scripts/build-knowledge.ts --math-only --lop-nur-twin ../lop-nur-twin
node scripts/build-knowledge.ts --math-only --lop-nur-twin ../lop-nur-twin --check
```

The list of project repositories lives in `PROJECTS` in [`scripts/build-knowledge.ts`](../scripts/build-knowledge.ts). [`NOTICES.md`](NOTICES.md) holds the license of every source.
