import { EngineError } from '../errors.ts';
export interface SqlResult {
  queryResult: unknown[];
  rowCount: number;
  fields: string[];
}

export async function queryDatabase(
  kind: 'mysql' | 'mssql',
  c: Record<string, string>,
  query: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<SqlResult> {
  signal.throwIfAborted();
  if (kind === 'mysql') {
    const mysql = await import('mysql2/promise');
    let options: import('mysql2').ConnectionOptions;
    if (c['connectionString']) {
      const u = new URL(c['connectionString']);
      if (!['mysql:', 'mariadb:'].includes(u.protocol))
        throw new EngineError('BAD_PAYLOAD', 'Use a mysql:// connection URL');
      options = {
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: decodeURIComponent(u.pathname.slice(1)),
      };
    } else
      options = {
        host: c['host'] || '127.0.0.1',
        port: Number(c['port'] || 3306),
        user: c['user'],
        password: c['password'],
        database: c['database'],
      };
    if (c['ssl'] === 'true') options.ssl = { rejectUnauthorized: true, ...(c['ca'] ? { ca: c['ca'] } : {}) };
    const client = await mysql.createConnection({ ...options, connectTimeout: 10000, multipleStatements: false });
    const abort = () => client.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const [rows, fields] = await client.execute({ sql: query, timeout: 60000 }, params as never);
      return {
        queryResult: Array.isArray(rows) ? rows : [],
        rowCount: Array.isArray(rows) ? rows.length : Number((rows as import('mysql2').ResultSetHeader).affectedRows),
        fields: fields?.map((f) => f.name) ?? [],
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await client.end().catch(() => {});
    }
  }
  const mod = await import('mssql');
  const sql = mod.default;
  const config: import('mssql').config = {
    server: c['host'] || '127.0.0.1',
    port: Number(c['port'] || 1433),
    user: c['user'],
    password: c['password'],
    database: c['database'],
    connectionTimeout: 10000,
    requestTimeout: 60000,
    options: { encrypt: c['encrypt'] !== 'false', trustServerCertificate: c['trustServerCertificate'] === 'true' },
    pool: { max: 1, min: 0 },
  };
  const pool = new sql.ConnectionPool(c['connectionString'] || config);
  await pool.connect();
  const request = pool.request();
  const abort = () => request.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    params.forEach((v, i) => request.input(`p${i + 1}`, v === undefined ? null : v));
    const r = await request.query(query);
    return {
      queryResult: r.recordset ?? [],
      rowCount: r.rowsAffected.reduce((a, b) => a + b, 0),
      fields: Object.keys(r.recordset?.columns ?? {}),
    };
  } finally {
    signal.removeEventListener('abort', abort);
    await pool.close();
  }
}
