import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { EngineError } from '../errors.ts';

export type ColumnType = 'text' | 'number' | 'integer' | 'boolean' | 'json';
export interface ColumnSpec { name: string; type: ColumnType }
export interface TableInfo { name: string; columns: ColumnSpec[]; rows: number }

export interface WhereClause {
  conjunction?: 'AND' | 'OR' | 'and' | 'or';
  conditions: { column: string; operator: string; value?: unknown }[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SYSTEM_COLUMNS: ColumnSpec[] = [{ name: 'id', type: 'integer' }, { name: 'created_at', type: 'text' }, { name: 'updated_at', type: 'text' }];
const SQL_TYPES: Record<ColumnType, string> = { text: 'TEXT', number: 'REAL', integer: 'INTEGER', boolean: 'INTEGER', json: 'TEXT' };
const OPERATORS: Record<string, string> = {
  '=': '=', '==': '=', 'eq': '=', '!=': '!=', '<>': '!=', 'neq': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
  'like': 'LIKE', 'ilike': 'LIKE', 'not like': 'NOT LIKE', 'in': 'IN', 'not in': 'NOT IN', 'is null': 'IS NULL', 'is not null': 'IS NOT NULL',
};

const q = (ident: string) => {
  if (!IDENT.test(ident)) throw new EngineError('BAD_PAYLOAD', `Invalid identifier "${ident.slice(0, 64)}"`);
  return `"${ident}"`;
};

/** Local data tables for flows (tablesNode): a separate SQLite file with typed columns. */
export class TablesStore {
  private readonly db: DatabaseSync;
  private readonly reader: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS _jasmine_tables (name TEXT PRIMARY KEY, columns TEXT NOT NULL, created_at TEXT NOT NULL)');
    this.reader = file === ':memory:' ? this.db : new DatabaseSync(file, { readOnly: true });
  }

  list(): TableInfo[] {
    return (this.db.prepare('SELECT name, columns FROM _jasmine_tables ORDER BY name').all() as { name: string; columns: string }[]).map((r) => ({
      name: r.name, columns: JSON.parse(r.columns) as ColumnSpec[],
      rows: (this.db.prepare(`SELECT count(*) AS n FROM ${q(r.name)}`).get() as { n: number }).n,
    }));
  }

  get(name: string): TableInfo | undefined {
    return this.list().find((t) => t.name === name);
  }

  create(name: string, columns: ColumnSpec[]): TableInfo {
    if (!IDENT.test(name) || name.startsWith('_') || name.startsWith('sqlite_')) throw new EngineError('BAD_PAYLOAD', 'Table names use letters, digits and _ and cannot start with _');
    if (this.get(name)) throw new EngineError('CONFLICT', `Table ${name} already exists`);
    const seen = new Set(SYSTEM_COLUMNS.map((c) => c.name));
    for (const c of columns) {
      if (!IDENT.test(c.name) || seen.has(c.name)) throw new EngineError('BAD_PAYLOAD', `Invalid or duplicate column "${c.name}"`);
      if (!SQL_TYPES[c.type]) throw new EngineError('BAD_PAYLOAD', `Unknown column type ${c.type}`);
      seen.add(c.name);
    }
    const defs = columns.map((c) => `${q(c.name)} ${SQL_TYPES[c.type]}`);
    this.db.exec(`CREATE TABLE ${q(name)} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${defs.length ? `${defs.join(', ')}, ` : ''}created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.prepare('INSERT INTO _jasmine_tables (name, columns, created_at) VALUES (?, ?, ?)').run(name, JSON.stringify(columns), new Date().toISOString());
    return this.get(name)!;
  }

  drop(name: string): boolean {
    if (!this.get(name)) return false;
    this.db.exec(`DROP TABLE ${q(name)}`);
    this.db.prepare('DELETE FROM _jasmine_tables WHERE name = ?').run(name);
    return true;
  }

  private table(name: string): TableInfo {
    const t = this.get(name);
    if (!t) throw new EngineError('NOT_FOUND', `Table "${name}" does not exist; create it under Context → Tables`);
    return t;
  }

  private encode(t: TableInfo, data: Record<string, unknown>): Record<string, SQLInputValue> {
    const out: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(data)) {
      const col = t.columns.find((c) => c.name === k);
      if (!col) {
        if (SYSTEM_COLUMNS.some((c) => c.name === k)) continue;
        throw new EngineError('BAD_PAYLOAD', `Table ${t.name} has no column "${k}"`);
      }
      out[k] = encodeValue(col.type, v);
    }
    return out;
  }

  private decode(t: TableInfo, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    for (const c of t.columns) {
      const v = row[c.name];
      if (v === null || v === undefined) continue;
      if (c.type === 'boolean') out[c.name] = v === 1 || v === 1n;
      else if (c.type === 'json' && typeof v === 'string') {
        try {
          out[c.name] = JSON.parse(v);
        } catch {
          out[c.name] = v;
        }
      }
    }
    return out;
  }

  private where(t: TableInfo, where: WhereClause | undefined): { sql: string; params: SQLInputValue[] } {
    if (!where?.conditions?.length) return { sql: '', params: [] };
    const params: SQLInputValue[] = [];
    const known = new Set([...t.columns.map((c) => c.name), ...SYSTEM_COLUMNS.map((c) => c.name)]);
    const parts = where.conditions.map((c) => {
      if (!known.has(c.column)) throw new EngineError('BAD_PAYLOAD', `Table ${t.name} has no column "${c.column}"`);
      const op = OPERATORS[String(c.operator ?? '=').toLowerCase()];
      if (!op) throw new EngineError('BAD_PAYLOAD', `Unknown operator ${c.operator}`);
      const col = c.column === 'id' || c.column === 'created_at' || c.column === 'updated_at' ? q(c.column) : q(c.column);
      if (op === 'IS NULL' || op === 'IS NOT NULL') return `${col} ${op}`;
      const type = t.columns.find((x) => x.name === c.column)?.type ?? 'text';
      if (op === 'IN' || op === 'NOT IN') {
        const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',').map((s) => s.trim());
        if (!list.length) return op === 'IN' ? '0' : '1';
        params.push(...list.map((v) => encodeValue(type, v)));
        return `${col} ${op} (${list.map(() => '?').join(', ')})`;
      }
      params.push(encodeValue(type, c.value));
      return String(c.operator).toLowerCase() === 'ilike' ? `lower(${col}) LIKE lower(?)` : `${col} ${op} ?`;
    });
    return { sql: ` WHERE ${parts.join(/^or$/i.test(where.conjunction ?? '') ? ' OR ' : ' AND ')}`, params };
  }

  select(name: string, o: { columns?: string[]; where?: WhereClause; orderBy?: { column: string; order?: string }[]; limit?: number; offset?: number } = {}) {
    const t = this.table(name);
    const cols = o.columns?.length ? o.columns.map(q).join(', ') : '*';
    const w = this.where(t, o.where);
    const order = o.orderBy?.length ? ` ORDER BY ${o.orderBy.map((x) => `${q(x.column)} ${/^desc$/i.test(x.order ?? '') ? 'DESC' : 'ASC'}`).join(', ')}` : ' ORDER BY id';
    const limit = Math.min(Math.max(Math.trunc(Number(o.limit ?? 100)) || 100, 1), 10_000);
    const offset = Math.max(Math.trunc(Number(o.offset ?? 0)) || 0, 0);
    const rows = this.db.prepare(`SELECT ${cols} FROM ${q(name)}${w.sql}${order} LIMIT ? OFFSET ?`).all(...w.params, limit, offset) as Record<string, unknown>[];
    const count = (this.db.prepare(`SELECT count(*) AS n FROM ${q(name)}${w.sql}`).get(...w.params) as { n: number }).n;
    return { rows: rows.map((r) => this.decode(t, r)), count };
  }

  insert(name: string, data: Record<string, unknown> | Record<string, unknown>[]) {
    const t = this.table(name);
    const list = Array.isArray(data) ? data : [data];
    const ids: number[] = [];
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      for (const item of list) {
        const values = this.encode(t, item);
        const keys = Object.keys(values);
        const res = this.db.prepare(`INSERT INTO ${q(name)} (${[...keys.map(q), 'created_at', 'updated_at'].join(', ')}) VALUES (${[...keys.map(() => '?'), '?', '?'].join(', ')})`).run(...keys.map((k) => values[k]!), now, now);
        ids.push(Number(res.lastInsertRowid));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { insertedCount: ids.length, ids };
  }

  update(name: string, data: Record<string, unknown>, where: WhereClause | undefined) {
    const t = this.table(name);
    if (!where?.conditions?.length) throw new EngineError('BAD_PAYLOAD', 'Update needs a where condition');
    const values = this.encode(t, data);
    const keys = Object.keys(values);
    if (!keys.length) return { updatedCount: 0 };
    const w = this.where(t, where);
    const res = this.db.prepare(`UPDATE ${q(name)} SET ${[...keys.map((k) => `${q(k)} = ?`), 'updated_at = ?'].join(', ')}${w.sql}`).run(...keys.map((k) => values[k]!), new Date().toISOString(), ...w.params);
    return { updatedCount: Number(res.changes) };
  }

  delete(name: string, where: WhereClause | undefined) {
    const t = this.table(name);
    if (!where?.conditions?.length) throw new EngineError('BAD_PAYLOAD', 'Delete needs a where condition');
    const w = this.where(t, where);
    const res = this.db.prepare(`DELETE FROM ${q(name)}${w.sql}`).run(...w.params);
    return { deletedCount: Number(res.changes) };
  }

  /** Read-only SQL (SELECT / WITH) with positional or named parameters. */
  query(sql: string, params: unknown[] | Record<string, unknown> = []) {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(';')) throw new EngineError('BAD_PAYLOAD', 'Only a single SELECT query is allowed; use insert/update/delete actions to change data');
    const stmt = this.reader.prepare(trimmed);
    const rows = (Array.isArray(params) ? stmt.all(...(params as SQLInputValue[])) : stmt.all(params as Record<string, SQLInputValue>)) as Record<string, unknown>[];
    return { rows, count: rows.length };
  }

  close() {
    if (this.reader !== this.db && this.reader.isOpen) this.reader.close();
    if (this.db.isOpen) this.db.close();
  }
}

function encodeValue(type: ColumnType, v: unknown): SQLInputValue {
  if (v === undefined || v === null || v === '') return type === 'text' ? (v === '' ? '' : null) : null;
  switch (type) {
    case 'number': return Number(v);
    case 'integer': return Math.trunc(Number(v));
    case 'boolean': return v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0;
    case 'json': return typeof v === 'string' ? v : JSON.stringify(v);
    default: return typeof v === 'string' ? v : JSON.stringify(v);
  }
}
