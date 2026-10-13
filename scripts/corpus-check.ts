/**
 * Runs the importer + compiler over a folder of AgentKit flow exports (`flows/*.ts`) and tallies diagnostics.
 * Files are read as TEXT: the `export const nodes = [...]` / `export const edges = [...]` arrays are
 * extracted and JSON-parsed. Nothing in the folder is imported or executed.
 *
 *   node scripts/corpus-check.ts <folder>
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compileFlow } from '../src/flow/compile.ts';
import { importStudioFlow } from '../src/flow/import.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import type { NodeHandler } from '../src/nodes/types.ts';

function extractArray(text: string, name: string): unknown[] | undefined {
  const at = text.search(new RegExp(`export\\s+const\\s+${name}\\s*(:[^=]+)?=\\s*\\[`));
  if (at < 0) return undefined;
  const start = text.indexOf('[', at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as unknown[];
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Stub handlers for node types the rebuild doesn't implement, so graph-level checks still run. */
function permissiveRegistry(types: Iterable<string>) {
  const registry = defaultRegistry();
  for (const type of types) {
    if (registry.get(type)) continue;
    const kind: NodeHandler['kind'] = /ResponseNode$/.test(type) ? 'response' : /TriggerNode$|^cronNode$/.test(type) ? 'trigger' : 'action';
    registry.register({ type, kind, run: async () => ({ output: {} }) });
  }
  return registry;
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/corpus-check.ts <folder-of-flow-exports>');
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.json'));
const tally = new Map<string, { severity: string; count: number; flows: Set<string>; examples: string[] }>();
let parsed = 0;
let unparsable = 0;
let compiled = 0;

for (const file of files) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  const nodes = file.endsWith('.json') ? (JSON.parse(text) as { nodes?: unknown[] }).nodes : extractArray(text, 'nodes');
  const edges = file.endsWith('.json') ? (JSON.parse(text) as { edges?: unknown[] }).edges : extractArray(text, 'edges');
  if (!nodes || !edges) {
    unparsable++;
    continue;
  }
  parsed++;
  const types = nodes.map((n) => (n as { data?: { nodeId?: string } }).data?.nodeId).filter((t): t is string => typeof t === 'string');
  let result;
  try {
    const imported = importStudioFlow({ nodes, edges }, { flowId: file, resolveFileRef: () => '(file contents not loaded)' });
    result = { diagnostics: [...imported.diagnostics, ...compileFlow(imported.definition, permissiveRegistry(types), { maxRecommendedNodes: 50 }).diagnostics] };
  } catch (e) {
    result = { diagnostics: [{ severity: 'error', code: 'IMPORT_SCHEMA', message: (e as Error).message.slice(0, 200) }] };
  }
  if (!result.diagnostics.some((d) => d.severity === 'error')) compiled++;
  for (const d of result.diagnostics) {
    const key = `${d.severity}:${d.code}`;
    const entry = tally.get(key) ?? { severity: d.severity, count: 0, flows: new Set<string>(), examples: [] };
    entry.count++;
    entry.flows.add(file);
    if (entry.examples.length < 3) entry.examples.push(`${file}${'nodeId' in d && d.nodeId ? ` [${d.nodeId}]` : ''}: ${d.message.slice(0, 160)}`);
    tally.set(key, entry);
  }
}

console.log(`files: ${files.length}  parsed: ${parsed}  unparsable: ${unparsable}  compiled without errors: ${compiled}\n`);
for (const [key, e] of [...tally].sort((a, b) => b[1].flows.size - a[1].flows.size)) {
  console.log(`${key.padEnd(40)} ${String(e.count).padStart(5)} occurrences in ${e.flows.size} flows`);
  for (const ex of e.examples) console.log(`    ${ex}`);
}
