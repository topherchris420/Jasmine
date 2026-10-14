import { randomUUID } from 'node:crypto';
import { json, parseJson, type JasmineDb } from '../db/database.ts';
import { EngineError } from '../errors.ts';

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  updatedAt: string;
}

/** Reusable prompt templates that can be inserted into AI nodes. */
export class PromptStore {
  private readonly db: JasmineDb;

  constructor(db: JasmineDb) {
    this.db = db;
  }

  list(): PromptTemplate[] {
    return this.db.all<{ id: string; name: string; description: string; messages: string; updated_at: string }>('SELECT * FROM prompts ORDER BY name')
      .map((r) => ({ id: r.id, name: r.name, description: r.description, messages: parseJson(r.messages, []), updatedAt: r.updated_at }));
  }

  upsert(input: { id?: string; name: string; description?: string; messages: unknown }): PromptTemplate {
    const name = input.name?.trim();
    if (!name || name.length > 120) throw new EngineError('BAD_PAYLOAD', 'Prompt name must contain 1–120 characters');
    if (!Array.isArray(input.messages) || input.messages.length === 0) throw new EngineError('BAD_PAYLOAD', 'A prompt needs at least one message');
    const messages = input.messages.map((m) => {
      const o = (m ?? {}) as { role?: unknown; content?: unknown };
      const role = o.role === 'system' || o.role === 'assistant' ? o.role : 'user';
      return { role, content: String(o.content ?? '') };
    });
    const id = input.id ?? randomUUID();
    this.db.run(
      `INSERT INTO prompts (id, name, description, messages, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, messages = excluded.messages, updated_at = excluded.updated_at`,
      id, name, input.description ?? '', json(messages), new Date().toISOString(),
    );
    return this.list().find((p) => p.id === id)!;
  }

  remove(id: string): boolean {
    return Number(this.db.run('DELETE FROM prompts WHERE id = ?', id).changes) > 0;
  }
}
