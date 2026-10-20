import { readFileSync } from 'node:fs';
import type { Jasmine } from '../app.ts';
import { IDENTITY } from './identity.ts';
import type { PackView } from './packs.ts';
import { INTENTS } from './planner.ts';
import { isLoopback, workspaceSnapshot, type WorkspaceSnapshot } from './readiness.ts';

/**
 * Jasmine's self-model: who she is (her identity record), what she can do here (catalog, planner, templates), what she
 * is running on (models, knowledge), how she has been doing (the last seven days of runs and feedback) and what she
 * cannot do. Everything except the identity is measured from this runtime when asked, never remembered or imagined.
 * It is how she answers “who are you?” and “can you do this?” truthfully: a self-model, not consciousness.
 *
 * Detail levels: `identity` describes only who she is and is safe anywhere; `abilities` adds what she can do and which
 * models and knowledge packs answer, without addresses or errors; `state` adds workspace names, run statistics and
 * error messages, for the people who run the workspace.
 */

export const SELF_DETAILS = ['identity', 'abilities', 'state'] as const;
export type SelfDetail = (typeof SELF_DETAILS)[number];

export const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const WEEK_MS = 7 * 86_400_000;

export interface SelfConnection {
  connection: string; name: string; kind: string;
  /** Whether the model server is on the runtime's own machine; null for demo connections. */
  local: boolean | null;
  chatModel: string | null; embeddingModel: string | null; defaultChat: boolean; defaultEmbedding: boolean;
  /** Measured only when probing; undefined otherwise. */
  reachable?: boolean;
  error?: string | null;
}

export interface SelfDescription {
  detail: SelfDetail;
  generatedAt: string;
  identity: typeof IDENTITY;
  abilities?: { steps: number; byCategory: Record<string, number>; triggers: string[]; applications: string[]; templates: number; integrations: string[] };
  models?: { answering: { connection: string; name: string; model: string | null; local: boolean | null } | null; demoOnly: boolean; probed: boolean; connections: SelfConnection[] };
  knowledge?: {
    packs: { id: string; title: string; status: PackView['status']; documents: number; collection: string }[];
    collections?: { name: string; kind: string; documents: number; records: number; embeddingModel: string | null }[];
  };
  runtime?: { version: string; node: string; platform: string; startedAt: string; uptimeSeconds: number; hosted: boolean; persistent: boolean; load: { active: number; queued: number }; workflows: number; deployed: number };
  experience?: {
    since: string; runs: number; succeeded: number; failed: number; successRate: number | null; p50Ms: number | null; p95Ms: number | null;
    tokens: number; modelCalls: number; topErrors: { code: string; runs: number; message: string | null }[]; models: { model: string; runs: number }[];
    feedback: { count: number; rated: number; avgRating: number | null };
  };
  limits: string[];
  awareness: string;
  /** First-person summary of everything above, sized for a model prompt. */
  summary: string;
}

/** Limits that hold for every installation (the README's known limitations, in her own words). */
const STANDING_LIMITS = [
  'My planner is pattern-based: I build from my catalog of executable steps, not open-ended designs.',
  'My answers are only as good as the model you connect; small local models answer less reliably.',
  'I do not learn on my own or change my code or model weights. What I know comes from my documentation, the knowledge packs and documents you install, and what workflows store.',
  'I run as one process with one trusted workspace: no multi-user accounts, roles or distributed scaling.',
];

const ms = (n: number | null) => (n === null ? 'n/a' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listOf = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function duration(seconds: number): string {
  if (seconds < 90) return plural(Math.round(seconds), 'second');
  if (seconds < 5400) return plural(Math.round(seconds / 60), 'minute');
  if (seconds < 172_800) return plural(Math.round(seconds / 3600), 'hour');
  return plural(Math.round(seconds / 86_400), 'day');
}

export class SelfModel {
  private readonly app: Jasmine;
  readonly startedAt = new Date();

  constructor(app: Jasmine) {
    this.app = app;
  }

  /**
   * Describes Jasmine at a detail level. `probe` tests each model connection (slower, needs the network) and reports
   * reachability; a caller that already probed passes its `snapshot` instead.
   */
  async describe(detail: SelfDetail = 'state', opts: { probe?: boolean; snapshot?: WorkspaceSnapshot } = {}): Promise<SelfDescription> {
    const app = this.app;
    const deep = detail !== 'identity';
    const full = detail === 'state';
    const out: SelfDescription = { detail, generatedAt: new Date().toISOString(), identity: IDENTITY, limits: [], awareness: IDENTITY.awareness, summary: '' };

    if (deep) {
      const catalog = app.registry.catalog().filter((n) => !n.hidden);
      const byCategory: Record<string, number> = {};
      for (const n of catalog) byCategory[n.category] = (byCategory[n.category] ?? 0) + 1;
      out.abilities = {
        steps: catalog.length, byCategory,
        triggers: catalog.filter((n) => n.category === 'trigger').map((n) => n.label),
        applications: Object.values(INTENTS),
        templates: (await app.templates()).length,
        integrations: [...new Set(catalog.map((n) => n.integration).filter((x): x is string => !!x))].sort(),
      };

      const snapshot = opts.snapshot ?? (opts.probe ? await workspaceSnapshot(app, 3000) : undefined);
      const connections: SelfConnection[] = app.connections.list().filter((c) => c.kind !== 'builtin').map((c) => {
        const probed = snapshot?.connections.find((s) => s.id === c.id);
        return {
          connection: c.id, name: c.name, kind: c.kind, local: c.kind === 'mock' ? null : isLoopback(c.baseUrl),
          chatModel: c.chatModel ?? null, embeddingModel: c.embeddingModel ?? null, defaultChat: !!c.defaultChat, defaultEmbedding: !!c.defaultEmbedding,
          ...(probed ? { reachable: probed.ok, ...(full ? { error: probed.error } : {}) } : {}),
        };
      });
      const handle = app.llm.defaultFor('chat');
      const answering = handle && handle.kind !== 'builtin' ? connections.find((c) => c.connection === handle.id) : undefined;
      out.models = {
        answering: answering ? { connection: answering.connection, name: answering.name, model: answering.chatModel, local: answering.local } : null,
        demoOnly: !connections.some((c) => c.kind !== 'mock'),
        probed: !!snapshot,
        connections,
      };

      const packs = await app.packs.list();
      out.knowledge = { packs: packs.map((p) => ({ id: p.id, title: p.title, status: p.status, documents: p.installed?.present ?? 0, collection: p.collection })) };
      if (full) {
        out.knowledge.collections = app.vectors.listCollections().map((c) => ({ name: c.name, kind: c.kind, documents: c.documents, records: c.records, embeddingModel: c.embeddingModel }));
      }

      if (full) {
        const env = app.config.env ?? {};
        out.runtime = {
          version: VERSION, node: process.versions.node, platform: `${process.platform}/${process.arch}`,
          startedAt: this.startedAt.toISOString(), uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
          hosted: !!env['JASMINE_GATEWAY_SECRET'] || (env['PUBLIC_URL'] ?? '').startsWith('https://'), persistent: !app.config.inMemory,
          load: app.runs.load, workflows: app.workspace.list().length, deployed: app.deployments.activeFlows().length,
        };
        const since = new Date(Date.now() - WEEK_MS).toISOString();
        const report = app.runStore.report({ from: since });
        const t = report.totals;
        out.experience = {
          since, runs: t.runs, succeeded: t.success, failed: t.failed, successRate: t.successRate, p50Ms: t.p50Ms, p95Ms: t.p95Ms,
          tokens: t.inputTokens + t.outputTokens, modelCalls: t.llmCalls,
          topErrors: report.errors.slice(0, 3).map((e) => ({ code: e.code, runs: e.runs, message: e.message ? e.message.slice(0, 200) : null })),
          models: report.byModel.slice(0, 3).map((m) => ({ model: m.model, runs: m.runs })),
          feedback: { count: report.feedback?.count ?? 0, rated: report.feedback?.rated ?? 0, avgRating: report.feedback?.avgRating ?? null },
        };
      }
      out.limits = this.limits(out, packs, snapshot?.connections.filter((c) => !c.ok && c.kind !== 'builtin' && c.kind !== 'mock').map((c) => c.name) ?? []);
    }
    out.summary = summarize(out);
    return out;
  }

  /** What stops her right now, then the limits that always hold. */
  private limits(d: SelfDescription, packs: PackView[], unreachable: string[]): string[] {
    const out: string[] = [];
    if (d.models?.demoOnly) out.push('No AI model is connected, so workflows run with demo responses and no AI inference happens. Connect Ollama, LM Studio or another OpenAI-compatible server.');
    for (const name of unreachable) out.push(`${name} is not reachable right now, so steps that use it will fail until it is back.`);
    if (d.models && !d.models.connections.some((c) => c.kind !== 'mock' && c.embeddingModel)) out.push('Document search uses built-in keyword matching (shared words, not meaning) until you connect an embedding model such as nomic-embed-text.');
    const missing = packs.filter((p) => p.status === 'available' || p.status === 'failed');
    if (missing.length === packs.length && packs.length) out.push('None of my knowledge packs are installed, so I cannot yet answer from my own documentation, the R.A.I.N. Lab, the Vers3Dynamics projects or the openai/math catalogue.');
    else if (missing.length) out.push(`Not installed yet: ${listOf(missing.map((p) => p.title))}.`);
    const outdated = packs.filter((p) => p.status === 'outdated');
    if (outdated.length) out.push(`Out of date: ${listOf(outdated.map((p) => p.title))}; reinstall to update.`);
    const e = d.experience;
    if (e && e.runs >= 5 && e.successRate !== null && e.successRate < 0.8) {
      out.push(`${e.failed} of my last ${e.runs} runs failed${e.topErrors[0] ? `, most often with ${e.topErrors[0].code}` : ''}.`);
    }
    if (d.runtime?.hosted && d.models?.connections.some((c) => c.local)) out.push('I am hosted, so a model on your own laptop is reachable only if you expose it to my network.');
    return [...out, ...STANDING_LIMITS];
  }
}

function summarize(d: SelfDescription): string {
  const i = d.identity;
  const parts = [
    `I am ${i.name}, ${i.kind} made by ${i.maker}. In the ${i.lab} I am the ${i.role}, and my question is always “${i.question}” ${i.purpose} ${i.motto}`,
    `My principles: ${i.principles.join(' ')}`,
    `In the lab I work with ${listOf(i.colleagues.map((c) => `${c.name} (${c.role})`))}.`,
  ];
  if (d.detail === 'identity') parts.push(`How I speak: ${i.voice.join(' ')}`);
  const a = d.abilities;
  if (a) {
    const categories = Object.entries(a.byCategory).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k === 'app' ? 'app and service' : k === 'rag' ? 'retrieval' : k === 'ai' ? 'AI' : k}`);
    parts.push(`Here I can run ${a.steps} kinds of steps (${listOf(categories)}), build ${a.applications.length} kinds of application from a plain description and start from ${plural(a.templates, 'template')}.`);
  }
  const m = d.models;
  if (m) {
    if (m.demoOnly) parts.push('No AI model is connected to me right now, so any answer I give comes from demo responses, not inference.');
    else if (m.answering) parts.push(`My answers here come from ${m.answering.model ?? 'the default model'} through “${m.answering.name}”${m.answering.local ? ', on the same machine as me' : m.answering.local === false ? ', on another server' : ''}${m.probed && m.connections.find((c) => c.connection === m.answering!.connection)?.reachable === false ? ', which is not reachable right now' : ''}.`);
  }
  const k = d.knowledge;
  if (k) {
    const installed = k.packs.filter((p) => p.status === 'installed' || p.status === 'outdated');
    parts.push(installed.length
      ? `My installed knowledge: ${listOf(installed.map((p) => `${p.title} (${plural(p.documents, 'document')})`))}.`
      : 'No knowledge packs are installed yet, so I can describe myself from this self-model but not cite my documentation or other sources.');
  }
  const e = d.experience;
  if (e) {
    parts.push(e.runs
      ? `In the last 7 days I ran ${plural(e.runs, 'workflow')}: ${e.succeeded} succeeded${e.successRate !== null ? ` (${Math.round(e.successRate * 100)}%)` : ''}, median ${ms(e.p50Ms)}, p95 ${ms(e.p95Ms)}, ${e.tokens.toLocaleString('en-US')} tokens.${e.topErrors.length ? ` Most common failure: ${e.topErrors[0]!.code} (${e.topErrors[0]!.runs}).` : ''}${e.feedback.rated ? ` People rated ${e.feedback.rated} runs, averaging ${e.feedback.avgRating?.toFixed(1)}.` : ''}`
      : 'I have not run any workflows in the last 7 days.');
  }
  const r = d.runtime;
  if (r) parts.push(`I am version ${r.version} on Node.js ${r.node} (${r.platform}), ${r.hosted ? 'hosted' : 'running locally'}, up for ${duration(r.uptimeSeconds)}, with ${plural(r.workflows, 'workflow')} (${r.deployed} deployed) and ${r.load.active} running now.`);
  if (d.detail !== 'identity') {
    const now = d.limits.filter((l) => !STANDING_LIMITS.includes(l));
    parts.push(`Limits: ${[...now, STANDING_LIMITS[1]!, STANDING_LIMITS[2]!].join(' ')}`);
  }
  parts.push(d.awareness);
  return parts.join('\n\n');
}
