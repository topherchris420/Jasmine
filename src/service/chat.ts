import type { JasmineDb } from '../db/database.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sessionId: string;
  runId?: string | null;
}

/** Conversation history per flow and session, fed back to chat flows as `chatHistory`. */
export class ChatStore {
  private readonly db: JasmineDb;

  constructor(db: JasmineDb) {
    this.db = db;
  }

  history(flowId: string, sessionId: string, limit = 20): ChatMessage[] {
    return this.db.all<{ role: string; content: string; created_at: string; session_id: string; run_id: string | null }>(
      'SELECT role, content, created_at, session_id, run_id FROM (SELECT * FROM chat_messages WHERE flow_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id',
      flowId, sessionId, Math.min(Math.max(limit, 1), 200),
    ).map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content, timestamp: r.created_at, sessionId: r.session_id, runId: r.run_id }));
  }

  append(flowId: string, sessionId: string, role: 'user' | 'assistant', content: string, runId?: string): void {
    this.db.run('INSERT INTO chat_messages (flow_id, session_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', flowId, sessionId, role, content.slice(0, 100_000), runId ?? null, new Date().toISOString());
  }

  sessions(flowId: string, limit = 100): { sessionId: string; messages: number; lastAt: string; preview: string }[] {
    return this.db.all<{ sessionId: string; messages: number; lastAt: string; preview: string }>(
      `SELECT session_id AS sessionId, count(*) AS messages, max(created_at) AS lastAt,
              (SELECT content FROM chat_messages m2 WHERE m2.flow_id = m.flow_id AND m2.session_id = m.session_id AND role = 'user' ORDER BY id LIMIT 1) AS preview
       FROM chat_messages m WHERE flow_id = ? GROUP BY session_id ORDER BY lastAt DESC LIMIT ?`, flowId, limit,
    );
  }

  /**
   * Retention follows the run log (Jasmine.pruneRuns): a transcript message goes when the run it came from is pruned,
   * and messages without a run go after `maxAgeDays` (0 keeps them).
   */
  prune(maxAgeDays: number): number {
    let removed = Number(this.db.run('DELETE FROM chat_messages WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs)').changes);
    if (maxAgeDays > 0) {
      removed += Number(this.db.run('DELETE FROM chat_messages WHERE run_id IS NULL AND created_at < ?', new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()).changes);
    }
    return removed;
  }

  clear(flowId: string, sessionId?: string): number {
    return Number((sessionId
      ? this.db.run('DELETE FROM chat_messages WHERE flow_id = ? AND session_id = ?', flowId, sessionId)
      : this.db.run('DELETE FROM chat_messages WHERE flow_id = ?', flowId)).changes);
  }
}
