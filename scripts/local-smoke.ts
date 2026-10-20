/**
 * End-to-end check against a real local model server: boots Jasmine in a temporary data directory,
 * deploys the starter chat flow and a RAG flow, indexes a document, and runs both.
 *
 *   LLM_PROVIDER=ollama npm run smoke:local          (or LLM_PROVIDER=openai LLM_BASE_URL=http://127.0.0.1:1234/v1)
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jasmine } from '../src/app.ts';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-smoke-'));
const app = await Jasmine.create({ dataDir, env: process.env, scheduler: false, log: console.log });
/** One line per run: the output on success, otherwise the error and the step it came from. */
const report = (label: string, res: { status: string; output?: unknown; error?: { code: string; message: string; nodeId?: string }; models?: unknown; timeTakenInSeconds?: number }) => {
  const outcome = res.status === 'success' ? JSON.stringify(res.output ?? null).slice(0, 400) : `${res.error?.code}: ${res.error?.message}${res.error?.nodeId ? ` (step ${res.error.nodeId})` : ''}`;
  console.log(`${label}:`, res.status, outcome, res.models ?? [], res.timeTakenInSeconds !== undefined ? `${res.timeTakenInSeconds}s` : '');
};
try {
  const defaults = app.connections.defaults();
  console.log('connections:', app.connections.list().map((c) => `${c.id}(${c.kind})`).join(', '), 'defaults:', defaults);
  const deployed = await app.deployFlow('getting-started');
  const chat = await app.runs.executeWorkflow('getting-started', { chatMessage: 'In one sentence: what is retrieval-augmented generation?' });
  report(`chat (${deployed.version})`, chat);

  app.vectors.createCollection({ name: 'smoke' });
  const doc = app.knowledge.ingest({ collection: 'smoke', type: 'text', title: 'Jasmine facts', text: 'Jasmine runs AI workflows on local models.\n\nThe default port of the Jasmine server is 8787.\n\nKnowledge bases are stored in SQLite.' });
  const ready = await app.knowledge.wait(doc.id);
  console.log('ingest:', ready.status, ready.chunks, ready.error ?? '');
  const rag = (await app.templates()).find((t) => t.id === 'knowledge-qa');
  if (rag) {
    await app.workspace.save('rag', rag.name, JSON.parse(JSON.stringify(rag.definition).replaceAll('"handbook"', '"smoke"')));
    await app.deployFlow('rag');
    const answer = await app.runs.executeWorkflow('rag', { question: 'Which port does the Jasmine server use?' });
    report('rag', answer);
    if (answer.status !== 'success') process.exitCode = 1;
  }
  if (chat.status !== 'success' || ready.status !== 'ready') process.exitCode = 1;
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
