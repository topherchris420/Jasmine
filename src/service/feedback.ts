import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { json, parseJson, type JasmineDb } from '../db/database.ts';
import { EngineError } from '../errors.ts';
import { logValue } from './runlog.ts';
const schema = z.object({
  requestId: z.string().min(1).optional(),
  requestIds: z.array(z.string().min(1)).min(1).max(25).optional(),
  rating: z.number().int().min(0).max(255).optional(),
  weight: z.number().min(0).max(1).optional(),
  comment: z.string().max(5000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export class FeedbackStore {
  constructor(db: JasmineDb) {
    this.db = db;
  }
  private readonly db: JasmineDb;
  submit(input: unknown) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new EngineError('BAD_PAYLOAD', 'Invalid feedback');
    const v = parsed.data;
    if (Boolean(v.requestId) === Boolean(v.requestIds))
      throw new EngineError('BAD_PAYLOAD', 'Supply exactly one of requestId or requestIds');
    if (v.rating === undefined && v.weight === undefined && !v.comment?.trim() && !Object.keys(v.metadata ?? {}).length)
      throw new EngineError('BAD_PAYLOAD', 'Supply at least one feedback value');
    let keys = 0;
    const inspect = (value: unknown, depth: number) => {
      if (depth > 5) throw new EngineError('BAD_PAYLOAD', 'Feedback metadata depth exceeds 5');
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
          if (++keys > 100) throw new EngineError('BAD_PAYLOAD', 'Feedback metadata exceeds 100 keys');
          inspect(item, depth + 1);
        }
      }
    };
    if (Buffer.byteLength(json(v.metadata ?? {})) > 16384)
      throw new EngineError('BAD_PAYLOAD', 'Feedback metadata exceeds 16 KB');
    inspect(v.metadata, 0);
    const ids = [...new Set([...(v.requestId ? [v.requestId] : []), ...(v.requestIds ?? [])])];
    if (!ids.length || ids.length > 25) throw new EngineError('BAD_PAYLOAD', 'Supply 1–25 request ids');
    const feedbackId = randomUUID(),
      timestamp = new Date().toISOString();
    const results = ids.map((requestId) => {
      if (!this.db.get('SELECT id FROM runs WHERE id=?', requestId))
        return { requestId, success: false, error: 'Run not found' };
      this.db.run(
        'INSERT INTO run_feedback(id,feedback_id,request_id,rating,weight,comment,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)',
        randomUUID(),
        feedbackId,
        requestId,
        v.rating ?? null,
        v.weight ?? 1,
        v.comment ?? '',
        json(logValue(v.metadata ?? {})),
        timestamp,
      );
      return { requestId, success: true };
    });
    const success = results.every((r) => r.success);
    return {
      success,
      message: success
        ? 'Feedback submitted successfully'
        : `Feedback submitted for ${results.filter((r) => r.success).length} of ${ids.length} requests`,
      data: {
        feedbackId,
        ...(ids.length === 1 ? { requestId: ids[0] } : { requestIds: ids }),
        rating: v.rating ?? null,
        weight: v.weight ?? 1,
        comment: v.comment ?? '',
        timestamp,
        results,
      },
      error: success ? null : 'Some runs were not found',
    };
  }
  list(requestId?: string) {
    return this.db
      .all<{
        id: string;
        feedback_id: string;
        request_id: string;
        rating: number | null;
        weight: number;
        comment: string;
        metadata: string;
        created_at: string;
      }>(
        `SELECT * FROM run_feedback ${requestId ? 'WHERE request_id=?' : ''} ORDER BY created_at DESC LIMIT 500`,
        ...(requestId ? [requestId] : []),
      )
      .map((r) => ({
        id: r.id,
        feedbackId: r.feedback_id,
        requestId: r.request_id,
        rating: r.rating,
        weight: r.weight,
        comment: r.comment,
        metadata: parseJson(r.metadata, {}),
        createdAt: r.created_at,
      }));
  }
}
