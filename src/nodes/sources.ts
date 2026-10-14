import { EngineError } from '../errors.ts';
import { f, jsonField, str, val } from './common.ts';
import type { NodeHandler } from './types.ts';

export const sourceHandlers: NodeHandler[] = [
  {
    type: 'sourceTriggerNode',
    kind: 'trigger',
    spec: {
      label: 'Scheduled Source',
      category: 'trigger',
      icon: 'database',
      description: 'Poll a configured app or database read action on a schedule and pass its records to a flow.',
      fields: [
        f.select('sourceNodeType', 'Source', [
          'googleDriveNode',
          'googleSheetsNode',
          'onedriveNode',
          'sharepointNode',
          'gmailNode',
          'webflowNode',
          'airtableNode',
          'notionNode',
          'githubNode',
          's3Node',
          'postgresNode',
          'mysqlNode',
          'mssqlNode',
          'rssNode',
        ]),
        f.json('sourceConfig', 'Source action configuration', {
          help: 'Use the source node action and credential fields. Write actions are rejected.',
        }),
        f.text('cronExpression', 'Cron expression'),
        f.text('cronTimezone', 'Time zone'),
        f.text('recordsField', 'Record list field', {
          help: 'For example files, items, queryResult, values. Leave blank to discover the first result list.',
        }),
      ],
      outputs: [
        { path: 'records', type: 'array' },
        { path: 'source', type: 'object' },
        { path: 'scheduledAt', type: 'string' },
      ],
      defaults: () => ({
        sourceNodeType: 'rssNode',
        sourceConfig: '{"url":""}',
        cronExpression: '*/15 * * * *',
        cronTimezone: '',
        recordsField: '',
      }),
    },
    async run(ctx) {
      if (!ctx.services.runSource)
        throw new EngineError('PROVIDER', 'Scheduled sources require the full Jasmine server');
      const config = jsonField(ctx, 'sourceConfig', {});
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new EngineError('BAD_PAYLOAD', 'sourceConfig must be an object');
      const output = await ctx.services.runSource(
        str(val(ctx, 'sourceNodeType')),
        config as Record<string, unknown>,
        ctx,
      );
      const source = output.output;
      const field = str(val(ctx, 'recordsField', ''));
      const record = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
      const records = field
        ? record[field]
        : Array.isArray(source)
          ? source
          : (Object.values(record).find(Array.isArray) ?? []);
      if (!Array.isArray(records))
        throw new EngineError('BAD_PAYLOAD', 'The selected source field is not a record list');
      return {
        ...output,
        output: {
          records,
          source,
          scheduledAt:
            (ctx.payload as Record<string, unknown> | undefined)?.['scheduledAt'] ?? new Date().toISOString(),
        },
      };
    },
  },
];
