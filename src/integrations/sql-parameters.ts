import { EngineError } from '../errors.ts';

/** Orders positional MySQL parameters when numbered template markers interleave with explicit ?. */
export function mysqlParameters(
  query: string,
  values: unknown[],
  explicitCount: number,
): { sql: string; params: unknown[] } {
  let sql = '',
    i = 0,
    quote = '',
    line = false,
    block = false,
    position = 0;
  const params: unknown[] = [];
  while (i < query.length) {
    const c = query[i]!,
      next = query[i + 1];
    if (line) {
      sql += c;
      i++;
      if (c === '\n') line = false;
      continue;
    }
    if (block) {
      sql += c;
      i++;
      if (c === '*' && next === '/') {
        sql += '/';
        i++;
        block = false;
      }
      continue;
    }
    if (quote) {
      if (query.startsWith('__jasmine_param_', i))
        throw new EngineError(
          'BAD_PAYLOAD',
          'SQL templates must occupy a whole bound value; use params for mixed strings',
        );
      sql += c;
      i++;
      if (c === '\\' && i < query.length) {
        sql += query[i++];
        continue;
      }
      if (c === quote) {
        if (next === quote) {
          sql += next;
          i++;
        } else quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      sql += c;
      i++;
      continue;
    }
    if (c === '#' || (c === '-' && next === '-' && /\s/.test(query[i + 2] ?? ' '))) {
      line = true;
      sql += c;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      block = true;
      sql += '/*';
      i += 2;
      continue;
    }
    const marker = /^__jasmine_param_(\d+)__/.exec(query.slice(i));
    if (marker) {
      const n = Number(marker[1]) - 1;
      if (n < explicitCount || n >= values.length)
        throw new EngineError('BAD_PAYLOAD', 'Invalid generated parameter marker');
      params.push(values[n]);
      sql += '?';
      i += marker[0].length;
      continue;
    }
    if (c === '?') {
      if (position >= explicitCount) throw new EngineError('BAD_PAYLOAD', 'Not enough SQL parameters');
      params.push(values[position++]);
      sql += '?';
      i++;
      continue;
    }
    sql += c;
    i++;
  }
  if (position !== explicitCount)
    throw new EngineError('BAD_PAYLOAD', 'SQL parameter count does not match placeholders');
  return { sql, params };
}
