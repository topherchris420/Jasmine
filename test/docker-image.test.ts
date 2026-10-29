import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCKERFILE = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

/** The repository paths the image copies: every source of every COPY. */
function copied(): string[] {
  return DOCKERFILE.split('\n').map((line) => line.trim().split(/\s+/)).filter((words) => words[0] === 'COPY')
    .flatMap((words) => words.slice(1, -1).filter((word) => !word.startsWith('--'))).map((source) => path.normalize(source));
}

/** Every file reached through relative imports (static, side-effect and literal dynamic) from `entry`. */
function imports(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      queue.push(path.resolve(path.dirname(file), m[1]!));
    }
  }
  return [...seen];
}

describe('the runtime image', () => {
  it('copies every module the server it starts imports', () => {
    const command = JSON.parse(/^CMD\s+(\[.*\])\s*$/m.exec(DOCKERFILE)![1]!) as string[];
    const entry = command.find((arg) => arg.endsWith('.ts'))!;
    const sources = copied();
    const missing = imports(path.join(ROOT, entry)).map((file) => path.relative(ROOT, file))
      .filter((file) => !sources.some((source) => file === source || file.startsWith(`${source}${path.sep}`)));
    expect(entry).toBe('src/api/server.ts');
    expect(missing).toEqual([]);
  });
});
