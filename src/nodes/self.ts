import { EngineError } from '../errors.ts';
import { f } from './common.ts';
import type { NodeHandler } from './types.ts';

/** How much the step tells: identity is safe anywhere; state names workspace details and belongs in private workflows. */
const DETAILS: [string, string][] = [
  ['identity', 'Who she is (safe for public widgets)'],
  ['abilities', 'Who she is and what she can do here'],
  ['state', 'Everything, including workspace names, run statistics and errors (private workflows only)'],
];

const selfHandler: NodeHandler = {
  type: 'selfNode',
  kind: 'action',
  spec: {
    label: 'About Jasmine', category: 'ai', icon: 'eye',
    description: 'Jasmine’s self-model, measured from this runtime when the step runs: who she is, what she can do here, which model answers, what knowledge she has and her limits. Pass its summary to a model step so answers about Jasmine stay true.',
    fields: [f.select('detail', 'Detail', DETAILS, { help: '“Who she is” mentions nothing about this workspace. “What she can do” adds step counts, the answering model and installed knowledge packs. “Everything” adds workflow and collection names, run statistics and error messages, so keep it out of public widgets.' })],
    outputs: [
      { path: 'summary', type: 'string', description: 'First-person self-description, sized for a prompt' },
      { path: 'identity', type: 'object', description: 'Name, role, question, principles, voice and colleagues' },
      { path: 'abilities', type: 'object' }, { path: 'models', type: 'object' }, { path: 'knowledge', type: 'object' },
      { path: 'experience', type: 'object', description: 'Last 7 days of runs (Everything only)' },
      { path: 'limits', type: 'string[]' },
    ],
    defaults: () => ({ nodeName: 'About Jasmine', detail: 'abilities' }),
  },
  validate(node) {
    const detail = node.values['detail'];
    return detail === undefined || detail === '' || DETAILS.some(([value]) => value === detail)
      ? []
      : [{ severity: 'error', code: 'FIELD_INVALID', message: 'detail must be identity, abilities or state', nodeId: node.id }];
  },
  async run(ctx) {
    if (!ctx.services.introspect) throw new EngineError('INTERNAL', 'This runtime cannot describe itself');
    const raw = ctx.values['detail'];
    const detail = raw === 'identity' || raw === 'state' ? raw : 'abilities';
    return { output: await ctx.services.introspect(detail) };
  },
};

export const selfHandlers: NodeHandler[] = [selfHandler];
