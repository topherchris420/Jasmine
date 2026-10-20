/**
 * Builds Jasmine's bundled knowledge packs (knowledge/*.json and knowledge/NOTICES.md) from local checkouts of the
 * repositories they describe. Files are read as TEXT: nothing in a checkout is imported or executed. The output is
 * deterministic, so rebuilding from the same commits gives byte-identical packs and a rebuild's diff shows exactly
 * what changed upstream.
 *
 *   node scripts/build-knowledge.ts --lop-nur-twin <dir> --james-library <dir> --repos <dir> [--check]
 *
 * --repos is a folder holding one checkout per project repository, named like the repository (circle, james, …);
 * a README-only sparse checkout is enough. Only public, non-fork repositories are listed in PROJECTS: private
 * repositories must never be bundled into this public one. --check rebuilds in memory and exits 1 when a pack on
 * disk differs from the rebuild.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { markdownSections } from '../src/vector/markdown.ts';

const OWNER = 'topherchris420';
const OUT = new URL('../knowledge/', import.meta.url);
const SCHEMA = 'jasmine-knowledge-pack/v1';

/** Public, non-fork repositories described in the projects pack (the lab's own repositories go into the lab pack). */
const PROJECTS: { repo: string; archived?: boolean }[] = [
  { repo: '33' }, { repo: 'anna' }, { repo: 'circle' }, { repo: 'cognisync-terrain-weaver' }, { repo: 'darpa-math-ponderer', archived: true },
  { repo: 'dynamic-resonance-rooting' }, { repo: 'embedded-ai-validation-platform' }, { repo: 'ghostwheel' }, { repo: 'ideas' },
  { repo: 'ions-x-deep-emergence-lab' }, { repo: 'james' }, { repo: 'Luca' }, { repo: 'nocturne' }, { repo: 'orpheus-resonance-protocol' },
  { repo: 'project-ascent' }, { repo: 'quantum-noise-profiler' }, { repo: 'quantum-spin-sound' }, { repo: 'rain-pipeline' },
  { repo: 'resona-lab-network', archived: true }, { repo: 'resonance-flow-nexus' }, { repo: 'resonate-ai-mesh' },
  { repo: 'satellite-vision-scape' }, { repo: 'topherchris420' }, { repo: 'triad' }, { repo: 'washingtondc-news', archived: true },
];

/** README sections that say nothing about what a project is. */
const SKIP_SECTION = /^(table of )?contents$|^licen[cs]e\b|^contribut|^acknowledg|^star history|^support\b|^sponsor|^contact$/i;

interface PackDocument { id: string; title: string; url?: string; text: string; metadata: Record<string, unknown> }
interface PackSource { repository: string; url: string; commit: string; paths: { path: string; sha256: string }[]; license: string; via?: string }
interface Pack {
  schema: string; id: string; title: string; description: string; caveats: string[]; license: string; notice: string;
  sources: PackSource[]; generator: string; contentSha256: string; documents: PackDocument[];
}

function args(): { lop: string; james: string; repos: string; check: boolean } {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    const value = i >= 0 ? argv[i + 1] : undefined;
    if (!value) throw new Error(`Missing ${name} <dir>. Usage: node scripts/build-knowledge.ts --lop-nur-twin <dir> --james-library <dir> --repos <dir> [--check]`);
    return path.resolve(value);
  };
  return { lop: get('--lop-nur-twin'), james: get('--james-library'), repos: get('--repos'), check: argv.includes('--check') };
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function commitOf(dir: string): string {
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${dir} is not a git checkout`);
  return commit;
}

function read(dir: string, file: string, used: { path: string; sha256: string }[]): string {
  const full = path.join(dir, file);
  if (!existsSync(full)) throw new Error(`${full} does not exist`);
  const bytes = readFileSync(full);
  used.push({ path: file, sha256: sha256(bytes) });
  return bytes.toString('utf8');
}

function licenseFile(dir: string): string | undefined {
  return readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
}

function spdx(text: string | undefined): string {
  if (!text) return 'NOASSERTION';
  const head = text.slice(0, 400);
  if (/MIT License/i.test(head)) return 'MIT';
  if (/Apache License/i.test(head) && /Version 2\.0/i.test(head)) return 'Apache-2.0';
  if (/CC0 1\.0/i.test(head)) return 'CC0-1.0';
  return 'NOASSERTION';
}

/** HTML and GitHub math marks out of catalogue text: `<i>p</i>` → p, `$\`x\`$` → $x$, entities decoded. */
function plain(text: string): string {
  return text
    .replace(/\$`([^`]+)`\$/g, (_m, tex: string) => `$${tex}$`)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Cuts text at a paragraph or sentence boundary before `max` characters. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. ') + 1);
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trim()} …`;
}

/** One document per README section, in order, until the repository's character budget is used. */
function readmeDocuments(o: { idPrefix: string; repo: string; commit: string; markdown: string; budget: number; fallbackTitle: string; metadata: Record<string, unknown>; titleSuffix?: string }): { title: string; documents: PackDocument[] } {
  const sections = markdownSections(o.markdown);
  const title = sections[0]?.heading || o.fallbackTitle;
  const documents: PackDocument[] = [];
  let left = o.budget;
  for (const section of sections) {
    if (left < 200) break;
    if (section.heading && section !== sections[0] && SKIP_SECTION.test(section.heading)) continue;
    const first = section === sections[0];
    const text = cap(section.text, Math.min(left, 4000));
    left -= text.length;
    documents.push({
      id: `${o.idPrefix}:${first ? 'intro' : section.anchor || documents.length}`,
      title: first ? `${title}${o.titleSuffix ?? ''}` : `${title} — ${section.heading}`,
      url: `https://github.com/${o.repo}${first ? '' : `#${section.anchor}`}`,
      text,
      metadata: { ...o.metadata, section: first ? 'Overview' : section.heading },
    });
  }
  // Two sections can share an anchor (two “Status” headings); keep ids unique.
  const seen = new Map<string, number>();
  for (const d of documents) {
    const n = (seen.get(d.id) ?? 0) + 1;
    seen.set(d.id, n);
    if (n > 1) d.id = `${d.id}-${n}`;
  }
  return { title, documents };
}

/** The first paragraph that reads like a description: the project's tagline for the index document. */
function tagline(markdown: string): string {
  const intro = markdownSections(markdown)[0]?.text ?? '';
  const paragraph = intro.split(/\n\n+/).map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length >= 40 && !/·.*·/.test(p) && !/^(warning|note|tip|important|caution):/i.test(p));
  return cap(paragraph ?? intro.replace(/\s+/g, ' ').trim(), 320);
}

function serialize(pack: Pack): string {
  const header = { ...pack, documents: '__DOCUMENTS__' };
  const docs = pack.documents.map((d) => `    ${JSON.stringify(d)}`).join(',\n');
  // A function replacement: document text may contain `$&` or `$$`, which a replacement string would expand.
  return `${JSON.stringify(header, null, 2).replace('"__DOCUMENTS__"', () => `[\n${docs}\n  ]`)}\n`;
}

function finish(pack: Omit<Pack, 'schema' | 'generator' | 'contentSha256'>): Pack {
  const ids = new Set<string>();
  for (const d of pack.documents) {
    if (ids.has(d.id)) throw new Error(`${pack.id}: duplicate document id ${d.id}`);
    ids.add(d.id);
    if (!d.text.trim()) throw new Error(`${pack.id}: document ${d.id} has no text`);
  }
  return { schema: SCHEMA, ...pack, generator: 'scripts/build-knowledge.ts', contentSha256: sha256(JSON.stringify(pack.documents)) };
}

/* ---------------- R.A.I.N. Lab ---------------- */

interface TeamMember { name: string; role: string; personality: string; focus: string; agreeableness: number }

/** The TEAM literal from lop-nur-twin's perspectives.ts, read as text. Fails when its shape changes rather than guessing. */
function parseTeam(source: string): TeamMember[] {
  const start = source.indexOf('export const TEAM');
  const end = source.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('perspectives.ts no longer declares TEAM');
  const body = source.slice(start, end);
  const members = body.split(/\n\s*\{\s*\n/).slice(1).map((block) => {
    const field = (key: string) => {
      const m = new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block);
      if (!m) throw new Error(`TEAM member without ${key}`);
      return JSON.parse(`"${m[1]}"`) as string;
    };
    const agreeable = /agreeableness:\s*([0-9.]+)/.exec(block);
    if (!agreeable) throw new Error('TEAM member without agreeableness');
    return { name: field('name'), role: field('role'), personality: field('personality'), focus: field('focus'), agreeableness: Number(agreeable[1]) };
  });
  if (members.map((m) => m.name).join() !== 'James,Jasmine,Luca,Elena') throw new Error(`Unexpected TEAM: ${members.map((m) => m.name).join(', ')}`);
  return members;
}

function rainLab(lop: string, james: string): Pack {
  const lopCommit = commitOf(lop);
  const jamesCommit = commitOf(james);
  const lopUsed: { path: string; sha256: string }[] = [];
  const jamesUsed: { path: string; sha256: string }[] = [];
  const blob = (file: string) => `https://github.com/${OWNER}/lop-nur-twin/blob/${lopCommit}/${file}`;
  const documents: PackDocument[] = [];

  const perspectives = JSON.parse(read(lop, 'src/rain/data/perspectives.json', lopUsed)) as { schema: string; license: string; souls: { name: string; file: string; sha256: string; text: string }[] };
  if (perspectives.schema !== 'rain-perspectives/v1') throw new Error(`Unexpected perspectives schema ${perspectives.schema}`);
  const team = parseTeam(read(lop, 'src/rain/meeting/perspectives.ts', lopUsed));
  for (const soul of perspectives.souls) {
    if (sha256(soul.text) !== soul.sha256) throw new Error(`${soul.file} does not match its recorded sha256`);
    const member = team.find((m) => m.name === soul.name);
    const text = soul.text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const role = /^role:\s*"([^"]+)"/m.exec(soul.text)?.[1] ?? member?.role ?? '';
    const sections = markdownSections(text);
    documents.push({
      id: `rain-lab:soul:${soul.name.toLowerCase()}`,
      title: `${soul.name} — ${role} (R.A.I.N. Lab persona)`,
      url: `https://github.com/${OWNER}/james_library/blob/main/${soul.file}`,
      text: [
        `${soul.name} is one of the four research perspectives of the R.A.I.N. Lab, defined by ${soul.file}. This is a character definition for lab meetings; its technical lines are the character's voice, not verified engineering data.`,
        ...sections.map((s) => (s === sections[0] ? s.text : `${s.heading}:\n${s.text}`)),
      ].join('\n\n'),
      metadata: { kind: 'persona', perspective: soul.name, role, file: soul.file, sha256: soul.sha256, license: perspectives.license },
    });
  }
  documents.push({
    id: 'rain-lab:team',
    title: 'The R.A.I.N. Lab research team',
    url: blob('src/rain/meeting/perspectives.ts'),
    text: [
      'The R.A.I.N. Lab (Resonant Adaptive Intelligence Network) is Vers3Dynamics’ research lab. Four perspectives bring different questions to a shared research question. In model-led meetings each one speaks with this role, personality and focus; agreeableness runs from 0.0 (combative) to 1.0 (very agreeable).',
      ...team.map((m) => `${m.name} — ${m.role}. Personality: ${m.personality} Focus: ${m.focus} Agreeableness: ${m.agreeableness}.`),
      'Jasmine, the Hardware Architect, is the same Jasmine as this workflow platform: her question “Can we actually build this?” became the purpose of the software.',
    ].join('\n\n'),
    metadata: { kind: 'team' },
  });

  const lopReadme = readmeDocuments({ idPrefix: 'rain-lab:readme', repo: `${OWNER}/lop-nur-twin`, commit: lopCommit, markdown: read(lop, 'README.md', lopUsed), budget: 16000, fallbackTitle: 'R.A.I.N. Lab', titleSuffix: ' (lop-nur-twin)', metadata: { kind: 'lab', repository: `${OWNER}/lop-nur-twin`, commit: lopCommit } });
  documents.push(...lopReadme.documents);
  for (const [file, budget] of [['docs/RAIN_SCIENTIFIC_AUTONOMY.md', 6000], ['docs/RAIN_MIGRATION.md', 8000], ['docs/MATH_PORTFOLIO.md', 6000]] as const) {
    const sections = markdownSections(read(lop, file, lopUsed));
    const title = sections[0]?.heading ?? file;
    let left = budget;
    for (const s of sections) {
      if (left < 200) break;
      const text = cap(s.text, Math.min(left, 4000));
      left -= text.length;
      documents.push({
        id: `rain-lab:${path.basename(file, '.md').toLowerCase()}:${s === sections[0] ? 'intro' : s.anchor}`,
        title: s === sections[0] ? title : `${title} — ${s.heading}`,
        url: `${blob(file)}${s === sections[0] ? '' : `#${s.anchor}`}`,
        text,
        metadata: { kind: 'lab', repository: `${OWNER}/lop-nur-twin`, commit: lopCommit, file },
      });
    }
  }
  const jamesReadme = readmeDocuments({ idPrefix: 'rain-lab:james-library', repo: `${OWNER}/james_library`, commit: jamesCommit, markdown: read(james, 'README.md', jamesUsed), budget: 9000, fallbackTitle: 'James Library', titleSuffix: ' (james_library, archived)', metadata: { kind: 'lab-history', repository: `${OWNER}/james_library`, commit: jamesCommit, archived: true } });
  for (const d of jamesReadme.documents) d.title = d.title.replace(/^R\.A\.I\.N\. Lab — /, 'James Library (archived) — ');
  documents.push(...jamesReadme.documents);

  const lopLicense = licenseFile(lop);
  const jamesLicense = licenseFile(james);
  return finish({
    id: 'rain-lab',
    title: 'R.A.I.N. Lab',
    description: 'Who Jasmine works with: the four lab perspectives (James, Jasmine, Luca and Elena), how the lab runs research, what it has measured, the boundaries it keeps and how it grew out of the James Library.',
    caveats: [
      'Persona files define characters for lab meetings. Their technical lines are character voice, not verified engineering data.',
      'Simulation results describe the simulator. They do not establish facts about real places, people, physical systems or the validity of a hypothesis.',
      'Pinned to the commits listed under sources; rebuild the pack to pick up later changes.',
    ],
    license: 'Apache-2.0 AND MIT',
    notice: 'Lab documentation from topherchris420/lop-nur-twin (Apache-2.0); persona files from topherchris420/james_library (MIT), as bundled in lop-nur-twin. See knowledge/NOTICES.md.',
    sources: [
      { repository: `${OWNER}/lop-nur-twin`, url: `https://github.com/${OWNER}/lop-nur-twin`, commit: lopCommit, paths: lopUsed, license: spdx(lopLicense ? readFileSync(path.join(lop, lopLicense), 'utf8') : undefined) },
      { repository: `${OWNER}/james_library`, url: `https://github.com/${OWNER}/james_library`, commit: jamesCommit, paths: jamesUsed, license: spdx(jamesLicense ? readFileSync(path.join(james, jamesLicense), 'utf8') : undefined) },
    ],
    documents,
  });
}

/* ---------------- Vers3Dynamics projects ---------------- */

function projects(reposDir: string): { pack: Pack; licenses: { repository: string; commit: string; spdx: string; text?: string }[] } {
  const documents: PackDocument[] = [];
  const sources: PackSource[] = [];
  const licenses: { repository: string; commit: string; spdx: string; text?: string }[] = [];
  const index: string[] = [];
  for (const { repo, archived } of PROJECTS) {
    const dir = path.join(reposDir, repo);
    if (!existsSync(dir)) throw new Error(`No checkout of ${OWNER}/${repo} in ${reposDir}`);
    const commit = commitOf(dir);
    const used: { path: string; sha256: string }[] = [];
    const readme = readdirSync(dir).find((f) => /^readme\.md$/i.test(f));
    if (!readme) throw new Error(`${OWNER}/${repo} has no README.md`);
    const markdown = read(dir, readme, used);
    const licenseName = licenseFile(dir);
    const licenseText = licenseName ? read(dir, licenseName, used) : undefined;
    const license = spdx(licenseText);
    const repository = `${OWNER}/${repo}`;
    const { title, documents: docs } = readmeDocuments({
      idPrefix: `projects:${repo.toLowerCase()}`, repo: repository, commit, markdown, budget: 9000, fallbackTitle: repo,
      titleSuffix: ` (${repository}${archived ? ', archived' : ''})`,
      metadata: { kind: 'project', repository, commit, license, ...(archived ? { archived: true } : {}) },
    });
    documents.push(...docs);
    index.push(`${title} (${repository}${archived ? ', archived' : ''}): ${tagline(markdown)}`);
    sources.push({ repository, url: `https://github.com/${repository}`, commit, paths: used, license });
    licenses.push({ repository, commit, spdx: license, ...(licenseText ? { text: licenseText } : {}) });
  }
  documents.unshift({
    id: 'projects:index',
    title: 'Vers3Dynamics public projects',
    url: `https://github.com/${OWNER}`,
    text: [
      `The public, non-fork repositories of ${OWNER} (Vers3Dynamics) besides Jasmine and the R.A.I.N. Lab repositories, each in its own words:`,
      ...index,
    ].join('\n\n'),
    metadata: { kind: 'project-index' },
  });
  return {
    pack: finish({
      id: 'vers3dynamics-projects',
      title: 'Vers3Dynamics projects',
      description: `What each of ${OWNER}’s ${PROJECTS.length} other public repositories says about itself: purpose, how it works, how to run it, its evidence and its limits.`,
      caveats: [
        'Each README describes its project in the project’s own words. It is not independent evidence that a method works.',
        'Built from public, non-fork repositories only. Private repositories are never bundled.',
        'Pinned to the commit listed for each repository; rebuild the pack to pick up later changes.',
      ],
      license: 'See knowledge/NOTICES.md (per repository)',
      notice: 'README excerpts from the author’s own public repositories, under each repository’s license; repositories without a license file are included by their author. See knowledge/NOTICES.md.',
      sources,
      documents,
    }),
    licenses,
  };
}

/* ---------------- openai/math ---------------- */

interface Manuscript { abstract: string | null; annotation: string | null; date: string | null; id: string; notes: string[]; path: string; status: string; title: string; citation?: { url?: string } }
interface Family {
  id: string; title: string; overview_title: string | null; status: string; summary: string | null; kinds: string[];
  discipline: { id: number; name: string };
  manuscripts: Manuscript[];
  formalization: null | { path: string; scope: string | null; statements: { result: string; theorems: string[]; catalogued_main_result: boolean }[] };
  reasoning_summary: null | { path: string; subject: string };
  issues: unknown[];
}
interface MathIndex {
  schema: string; repository: string; repository_url: string; commit: string; commit_date: string; content_sha256: string;
  counts: Record<string, number>; disciplines: { id: number; name: string; families: number }[];
  catalogue: { review_status: string; formalization_scope: string; formalization_version: string };
  collection: { sections: { heading: string; text: string }[] };
  families: Family[];
}

const VERIFIED = 'Formalized: the catalogue records a Lean formalization for this result family (comparator challenge statements). Jasmine has not compiled or checked the proof.';
const UNVERIFIED = 'Manuscript only: no Lean formalization is catalogued. The openai/math README warns that unformalized results could have issues.';

function openaiMath(lop: string): { pack: Pack; license: string } {
  const used: { path: string; sha256: string }[] = [];
  const lopCommit = commitOf(lop);
  const file = 'src/rain/mathematics/data/openai-math.json';
  const index = JSON.parse(read(lop, file, used)) as MathIndex;
  const license = read(lop, 'src/rain/mathematics/data/LICENSE.md', used);
  if (index.schema !== 'rain-math-substrate-index/v1' || index.repository !== 'openai/math') throw new Error(`Unexpected math index ${index.schema} for ${index.repository}`);
  const short = index.commit.slice(0, 7);
  const pinned = (p: string) => `https://github.com/openai/math/blob/${index.commit}/${p}`;
  const formalized = index.families.filter((f) => f.formalization).length;
  const documents: PackDocument[] = [];

  documents.push({
    id: 'openai-math:overview',
    title: 'openai/math — what the collection is',
    url: `https://github.com/openai/math/tree/${index.commit}`,
    text: [
      `openai/math is OpenAI’s public collection of mathematical manuscripts and supporting proof artifacts produced by an internal OpenAI model. This knowledge pack is an index of it at commit ${short} (${index.commit_date.slice(0, 10)}), read through the R.A.I.N. Lab’s pinned, provenance-checked catalogue in ${OWNER}/lop-nur-twin.`,
      ...index.collection.sections.map((s) => `${s.heading}:\n${plain(s.text)}`),
      `Counts: ${index.families.length} result families in ${index.disciplines.length} disciplines, ${index.counts['manuscripts'] ?? '?'} manuscripts, ${index.counts['statements'] ?? '?'} catalogued formal statements and ${index.counts['reasoning_summaries'] ?? '?'} reasoning summaries. ${formalized} families have a catalogued Lean formalization; ${index.families.length - formalized} are manuscript only. The catalogue’s own review status is “${index.catalogue.review_status}”, and its Lean formalization scope is “${index.catalogue.formalization_scope}” (${index.catalogue.formalization_version}).`,
      `Disciplines: ${index.disciplines.map((d) => `${d.name} (${d.families})`).join(', ')}.`,
      'How to read a result: “formalized” means the catalogue records Lean statements for the main result, not that Jasmine compiled them; “manuscript only” means no formal check is catalogued. A matching title or keyword does not show that a result applies to a different problem.',
    ].join('\n\n'),
    metadata: { kind: 'math-overview', repository: 'openai/math', commit: index.commit },
  });

  for (const d of index.disciplines) {
    const members = index.families.filter((f) => f.discipline.id === d.id);
    documents.push({
      id: `openai-math:discipline:${d.id}`,
      title: `openai/math — ${d.name} results`,
      url: `https://github.com/openai/math/tree/${index.commit}`,
      text: [
        `${d.name} in openai/math (commit ${short}): ${members.length} result families, ${members.filter((f) => f.formalization).length} with a catalogued Lean formalization.`,
        ...members.map((f) => `${f.id} · ${plain(f.title)} — ${f.formalization ? 'formalized (Lean)' : 'manuscript only'}`),
      ].join('\n'),
      metadata: { kind: 'math-discipline', discipline: d.name, families: members.length },
    });
  }

  for (const f of index.families) {
    const parts = [
      `Result family ${f.id} in openai/math (commit ${short}): ${plain(f.title)}`,
      `Discipline: ${f.discipline.name}.`,
      f.formalization ? VERIFIED : UNVERIFIED,
    ];
    if (f.overview_title && plain(f.overview_title) !== plain(f.title)) parts.push(`Also listed as: ${plain(f.overview_title)}.`);
    if (f.summary) parts.push(`Summary: ${plain(f.summary)}`);
    for (const m of f.manuscripts) {
      const notes = [m.annotation, ...m.notes].filter((x): x is string => !!x).map((n) => plain(n).replace(/\.$/, ''));
      parts.push(`Manuscript “${plain(m.title)}”${m.date ? ` (${m.date})` : ''}, ${m.status === 'formalized' ? 'formalized' : 'not formalized'}${notes.length ? `; ${notes.join('; ')}` : ''}.${m.abstract ? ` Abstract: ${plain(m.abstract)}` : ''} PDF: ${pinned(m.path)}`);
    }
    if (f.formalization) {
      if (f.formalization.scope) parts.push(`Formal scope: ${plain(f.formalization.scope)}`);
      const theorems = f.formalization.statements.flatMap((s) => s.theorems.map((t) => `${t} (${plain(s.result)})`));
      if (theorems.length) parts.push(`Lean theorems: ${theorems.join('; ')}.`);
    }
    if (f.reasoning_summary) parts.push(`A reasoning summary is published: ${plain(f.reasoning_summary.subject)} (${pinned(f.reasoning_summary.path)}).`);
    documents.push({
      id: `openai-math:family:${f.id}`,
      title: `openai/math ${f.id} · ${plain(f.title)}`,
      url: f.manuscripts[0] ? pinned(f.manuscripts[0].path) : `https://github.com/openai/math/tree/${index.commit}`,
      text: parts.join('\n\n'),
      metadata: {
        kind: 'math-result', family: f.id, discipline: f.discipline.name, verification: f.formalization ? 'formalized' : 'manuscript',
        manuscripts: f.manuscripts.length, ...(f.formalization ? { formalization: pinned(f.formalization.path) } : {}),
      },
    });
  }

  return {
    pack: finish({
      id: 'openai-math',
      title: 'openai/math catalogue',
      description: `${index.families.length} research-level result families from openai/math in ${index.disciplines.length} disciplines: what each result claims, its manuscripts and abstracts, and whether a Lean formalization is catalogued (${formalized}) or it is manuscript only (${index.families.length - formalized}).`,
      caveats: [
        'Produced by an internal OpenAI model. The collection’s own README says unformalized results could have issues.',
        '“Formalized” means the catalogue records a Lean formalization for the result family. Jasmine has not compiled or checked any proof.',
        'A matching title or keyword is not evidence that a result applies to your problem.',
        `An index pinned to openai/math commit ${short}: titles, summaries, abstracts, citations and formal scope only. No manuscript, LaTeX, Lean source or PDF is copied.`,
      ],
      license: 'Apache-2.0',
      notice: `Derived from openai/math (https://github.com/openai/math, Apache-2.0) at commit ${index.commit}, through the index in ${OWNER}/lop-nur-twin; reformatted into knowledge documents by Jasmine. See knowledge/NOTICES.md.`,
      sources: [
        { repository: 'openai/math', url: index.repository_url, commit: index.commit, paths: [], license: 'Apache-2.0', via: `${OWNER}/lop-nur-twin@${lopCommit}:${file}` },
        { repository: `${OWNER}/lop-nur-twin`, url: `https://github.com/${OWNER}/lop-nur-twin`, commit: lopCommit, paths: used, license: 'Apache-2.0' },
      ],
      documents,
    }),
    license,
  };
}

/* ---------------- notices and output ---------------- */

function notices(lop: string, james: string, mathLicense: string, projectLicenses: { repository: string; commit: string; spdx: string; text?: string }[]): string {
  const section = (title: string, commit: string, body: string) => `## ${title} (${commit.slice(0, 7)})\n\n${body.trim()}\n`;
  const fence = (text: string) => `\`\`\`text\n${text.trim()}\n\`\`\``;
  const lopLicense = licenseFile(lop);
  const jamesLicense = licenseFile(james);
  return [
    '# Knowledge pack notices',
    'Generated by `scripts/build-knowledge.ts`. The bundled knowledge packs quote or index the repositories below; each keeps its own license. Repositories without a license file are the author’s own public work, included by the author.',
    section('openai/math, through topherchris420/lop-nur-twin', commitOf(lop), mathLicense.replace(/^#\s/gm, '### ')),
    section('topherchris420/lop-nur-twin', commitOf(lop), lopLicense ? fence(readFileSync(path.join(lop, lopLicense), 'utf8')) : 'No license file.'),
    section('topherchris420/james_library', commitOf(james), jamesLicense ? fence(readFileSync(path.join(james, jamesLicense), 'utf8')) : 'No license file.'),
    ...projectLicenses.map((l) => section(l.repository, l.commit, l.text ? fence(l.text) : 'No license file in the repository; README excerpts included by the author.')),
  ].join('\n\n');
}

const options = args();
const lab = rainLab(options.lop, options.james);
const projectPack = projects(options.repos);
const math = openaiMath(options.lop);
const outputs = new Map<string, string>([
  ['rain-lab.json', serialize(lab)],
  ['vers3dynamics-projects.json', serialize(projectPack.pack)],
  ['openai-math.json', serialize(math.pack)],
  ['NOTICES.md', notices(options.lop, options.james, math.license, projectPack.licenses)],
]);
let stale = 0;
for (const [name, text] of outputs) {
  const target = new URL(name, OUT);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (options.check) {
    if (current !== text) {
      stale++;
      console.error(`${name} is out of date`);
    }
  } else {
    writeFileSync(target, text);
  }
}
for (const pack of [lab, projectPack.pack, math.pack]) {
  console.log(`${pack.id}: ${pack.documents.length} documents, ${pack.documents.reduce((n, d) => n + d.text.length, 0).toLocaleString()} characters, sha256 ${pack.contentSha256.slice(0, 12)}`);
}
if (stale) process.exit(1);
