import { MongoClient } from 'mongodb';
import { DbConnectionConfig, DbQueryResult } from './types';

const WRITE_OPS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'];

export class MongoDriver {
  private client: MongoClient | null = null;
  private dbName: string = '';

  async connect(config: DbConnectionConfig): Promise<void> {
    const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@` : '';
    const uri = `mongodb://${auth}${config.host}:${config.port}/${config.database}${config.ssl ? '?ssl=true' : ''}`;
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await this.client.connect();
    this.dbName = config.database;
    await this.client.db(this.dbName).command({ ping: 1 });
  }

  async listCollections(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    const cols = await this.client.db(this.dbName).listCollections().toArray();
    return cols.map((c) => c.name);
  }

  async query(
    collection: string,
    operation: 'find' | 'aggregate' | 'countDocuments' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany',
    filter: any,
    pipeline: any[] | undefined,
    timeoutMs = 10000,
    rowLimit = 1000,
    commit = false,
    document?: any,
    update?: any
  ): Promise<DbQueryResult> {
    if (!this.client) throw new Error('Not connected');
    const coll = this.client.db(this.dbName).collection(collection);

    if (!WRITE_OPS.includes(operation)) {
      // Read operations don't need transaction wrapping — no side effects.
      if (operation === 'countDocuments') {
        const count = await coll.countDocuments(filter || {}, { maxTimeMS: timeoutMs });
        return { rows: [{ count }] };
      }
      if (operation === 'aggregate') {
        const rows = await coll.aggregate(pipeline || [], { maxTimeMS: timeoutMs }).limit(rowLimit).toArray();
        return { rows };
      }
      const rows = await coll.find(filter || {}, { maxTimeMS: timeoutMs }).limit(rowLimit).toArray();
      return { rows };
    }

    // Write operations run inside a session transaction — auto-aborted
    // unless `commit` is true. Requires a replica-set/sharded deployment
    // (Atlas clusters support this by default; a standalone mongod does not).
    const session = this.client.startSession();
    const ABORT_SENTINEL = Symbol('intentional-rollback');
    try {
      let result: any;
      try {
        await session.withTransaction(async () => {
          if (operation === 'insertOne') result = await coll.insertOne(document, { session });
          else if (operation === 'insertMany') result = await coll.insertMany(document, { session });
          else if (operation === 'updateOne') result = await coll.updateOne(filter || {}, update || {}, { session });
          else if (operation === 'updateMany') result = await coll.updateMany(filter || {}, update || {}, { session });
          else if (operation === 'deleteOne') result = await coll.deleteOne(filter || {}, { session });
          else if (operation === 'deleteMany') result = await coll.deleteMany(filter || {}, { session });

          if (!commit) {
            // Throwing the sentinel makes the driver abort the transaction
            // (its documented way of triggering a rollback), while still
            // letting us keep the write's result to report back.
            throw ABORT_SENTINEL;
          }
        });
      } catch (err) {
        if (err !== ABORT_SENTINEL) throw err;
      }
      return { rows: [result || {}] };
    } catch (err: any) {
      if (/Transaction numbers are only allowed|IllegalOperation.*replica set/i.test(err.message || '')) {
        throw new Error('WRITE_REQUIRES_REPLICA_SET: this MongoDB deployment does not support transactions (standalone mongod). Write operations require a replica-set or sharded deployment — Atlas clusters support this by default.');
      }
      throw err;
    } finally {
      await session.endSession().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
  }
}
