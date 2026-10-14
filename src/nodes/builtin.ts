import { sourceHandlers } from './sources.ts';
import { documentHandlers } from './documents.ts';
import { aiHandlers } from './ai.ts';
import { appHandlers } from './apps.ts';
import { coreHandlers } from './core.ts';
import { ragHandlers } from './rag.ts';
import { NodeRegistry } from './types.ts';

/** Every node type Jasmine can run: triggers, responses, logic, AI, RAG/vector/memory, data and app integrations. */
export function defaultRegistry(): NodeRegistry {
  return new NodeRegistry([...coreHandlers, ...aiHandlers, ...ragHandlers, ...appHandlers, ...documentHandlers,...sourceHandlers]);
}
