import type { Jasmine } from '../app.ts';
import { EngineError } from '../errors.ts';
import { chat, type ModelRef } from '../llm/router.ts';
import { z } from 'zod';
const schema = z.object({
  models: z
    .array(z.object({ connection: z.string().optional(), model: z.string().optional() }))
    .min(1)
    .max(8),
  cases: z
    .array(z.object({ prompt: z.string().min(1).max(8000), expectedSubstring: z.string().max(500).optional() }))
    .min(1)
    .max(20),
});
/** Reproducible user-defined local model comparisons, with measured latency and explicit quality checks. */
export async function compareModels(app: Jasmine, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new EngineError('BAD_PAYLOAD', 'Provide 1–8 models and 1–20 prompt cases');
  const results = [];
  for (const model of parsed.data.models) {
    for (const c of parsed.data.cases) {
      const start = performance.now();
      try {
        const r = await chat(app.llm, {
          ref: model as ModelRef,
          messages: [{ role: 'user', content: c.prompt }],
          maxTokens: 1024,
          signal: AbortSignal.timeout(120000),
        });
        results.push({
          connection: r.connectionId,
          model: r.model,
          prompt: c.prompt,
          text: r.text,
          latencyMs: Math.round(performance.now() - start),
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          passed:
            c.expectedSubstring === undefined ? null : r.text.toLowerCase().includes(c.expectedSubstring.toLowerCase()),
          error: null,
        });
      } catch (e) {
        results.push({
          connection: model.connection ?? null,
          model: model.model ?? null,
          prompt: c.prompt,
          text: null,
          latencyMs: Math.round(performance.now() - start),
          passed: false,
          error: e instanceof EngineError ? e.message : 'Model call failed',
        });
      }
    }
  }
  return { createdAt: new Date().toISOString(), cases: parsed.data.cases, results };
}
