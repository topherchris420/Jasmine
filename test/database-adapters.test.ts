import { describe, expect, it, vi } from 'vitest';
import { mysqlParameters } from '../src/integrations/sql-parameters.ts';
import { createTestApp } from './helpers.ts';
const drivers = vi.hoisted(() => ({
  mysql: vi.fn(async () => [[{ answer: 42 }], [{ name: 'answer' }]]),
  mssql: vi.fn(async () => ({ recordset: [{ answer: 42 }], rowsAffected: [1] })),
  inputs: vi.fn(),
  closed: vi.fn(),
  destroyed: vi.fn(),
}));
vi.mock('mysql2/promise', () => ({
  createConnection: async () => ({
    execute: drivers.mysql,
    end: async () => drivers.closed(),
    destroy: drivers.destroyed,
  }),
}));
vi.mock('mssql', () => ({
  default: {
    ConnectionPool: class {
      async connect() {
        return this;
      }
      request() {
        return { input: drivers.inputs, query: drivers.mssql, cancel: drivers.destroyed };
      }
      async close() {
        drivers.closed();
      }
    },
  },
}));
const flow = (type: string, query: string, params: unknown[]) => ({
  nodes: [
    { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
    { id: 'a', data: { nodeId: type, values: { query, params } } },
    { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{a.output}}' } } },
  ],
  edges: [
    { source: 't', target: 'a' },
    { source: 'a', target: 'r' },
  ],
});
describe('database adapter contracts', () => {
  it('orders positional parameters correctly across templates, strings, and comments', () => {
    expect(mysqlParameters("SELECT __jasmine_param_2__, ?, '?' /* ? */", ['explicit', 'templated'], 1)).toEqual({
      sql: "SELECT ?, ?, '?' /* ? */",
      params: ['templated', 'explicit'],
    });
    expect(() => mysqlParameters('SELECT ?', [], 0)).toThrow();
  });
  it('executes MySQL with bound user values instead of interpolating SQL', async () => {
    const t = await createTestApp();
    try {
      t.app.credentials.upsert({
        integration: 'mysql',
        name: 'db',
        data: { host: '127.0.0.1', user: 'test', password: 'secret' },
      });
      await t.app.deployments.deploy('q', flow('mysqlNode', 'SELECT {{t.output.value}} AS a, ? AS b', ['explicit']));
      const hostile = "x'; DROP TABLE users; --";
      const result = await t.app.runs.executeWorkflow('q', { value: hostile });
      expect(result.status).toBe('success');
      expect(drivers.mysql).toHaveBeenCalledWith({ sql: 'SELECT ? AS a, ? AS b', timeout: 60000 }, [
        hostile,
        'explicit',
      ]);
      expect(drivers.closed).toHaveBeenCalled();
    } finally {
      await t.close();
    }
  });
  it('binds SQL Server parameters by name and returns rows', async () => {
    const t = await createTestApp();
    try {
      t.app.credentials.upsert({ integration: 'mssql', name: 'db', data: { host: '127.0.0.1', user: 'test' } });
      await t.app.deployments.deploy('q', flow('mssqlNode', 'SELECT {{t.output.value}} AS value', []));
      const result = await t.app.runs.executeWorkflow('q', { value: 42 });
      expect(result.output).toMatchObject({ queryResult: [{ answer: 42 }], rowCount: 1 });
      expect(drivers.inputs).toHaveBeenCalledWith('p1', 42);
      expect(drivers.mssql).toHaveBeenCalledWith('SELECT @p1 AS value');
    } finally {
      await t.close();
    }
  });
});
