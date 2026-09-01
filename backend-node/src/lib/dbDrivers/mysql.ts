import mysql from 'mysql2/promise';
import { DbConnectionConfig, DbQueryResult } from './types';

export class MysqlDriver {
  private conn: mysql.Connection | null = null;

  async connect(config: DbConnectionConfig): Promise<void> {
    const options: mysql.ConnectionOptions = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      connectTimeout: 10000,
    };
    if (config.ssl) options.ssl = {};
    this.conn = await mysql.createConnection(options);
    await this.conn.query('SELECT 1');
  }

  // Every query — read or write — runs inside an explicit transaction.
  // Unless `commit` is true, it's always rolled back after assertions have
  // had a chance to see the query's effect within the same transaction,
  // so a write step never leaves permanent side effects by default.
  async query(sql: string, params: any[] = [], timeoutMs = 10000, rowLimit = 1000, commit = false): Promise<DbQueryResult> {
    if (!this.conn) throw new Error('Not connected');
    await this.conn.beginTransaction();
    try {
      const [rows, fields] = await this.conn.query({ sql, timeout: timeoutMs }, params);
      const limitedRows = Array.isArray(rows) ? (rows as any[]).slice(0, rowLimit) : [rows];
      const result: DbQueryResult = { rows: limitedRows };
      if (Array.isArray(fields)) result.columns = fields.map((f: any) => f.name);
      if (commit) await this.conn.commit();
      else await this.conn.rollback();
      return result;
    } catch (err) {
      await this.conn.rollback().catch(() => {});
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.conn?.end().catch(() => {});
  }
}
