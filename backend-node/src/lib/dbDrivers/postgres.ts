import { Pool } from 'pg';
import { DbConnectionConfig, DbQueryResult } from './types';

export class PostgresDriver {
  private pool: Pool | null = null;

  async connect(config: DbConnectionConfig): Promise<void> {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
      max: 1,
    });
    // Fail fast on bad credentials/host rather than surfacing a confusing error on the first real query.
    await this.pool.query('SELECT 1');
  }

  // Every query — read or write — runs inside an explicit transaction.
  // Unless `commit` is true, it's always rolled back after assertions have
  // had a chance to see the query's effect within the same transaction,
  // so a write step never leaves permanent side effects by default.
  async query(sql: string, params: any[] = [], timeoutMs = 10000, rowLimit = 1000, commit = false): Promise<DbQueryResult> {
    if (!this.pool) throw new Error('Not connected');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const res = await client.query(sql, params);
      const rows = Array.isArray(res.rows) ? res.rows.slice(0, rowLimit) : [];
      const columns = res.fields?.map((f: any) => f.name);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return { rows, columns };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end().catch(() => {});
  }
}
