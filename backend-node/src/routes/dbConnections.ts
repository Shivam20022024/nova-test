import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { encrypt, decrypt } from '../lib/crypto';
import { PostgresDriver } from '../lib/dbDrivers/postgres';
import { MysqlDriver } from '../lib/dbDrivers/mysql';
import { MongoDriver } from '../lib/dbDrivers/mongo';
import { introspectSchema } from '../lib/dbSchemaIntrospection';

const router = Router();
router.use(authenticate);

const ENGINES = ['postgres', 'mysql', 'mongodb'];

function createDriver(engine: string) {
  if (engine === 'mysql') return new MysqlDriver();
  if (engine === 'mongodb') return new MongoDriver();
  return new PostgresDriver();
}

function toSafeConnection(conn: any) {
  const { encryptedPassword, ...safe } = conn;
  return safe;
}

// GET /api/v1/db-connections?projectId=...
router.get('/', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    const { data: connections, error } = await supabase
      .from('DbConnection')
      .select('*')
      .eq('projectId', projectId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    // Password is never returned, not even masked — stricter than the existing Jira integration pattern.
    res.json((connections || []).map(toSafeConnection));
  } catch (err: any) {
    console.error('Error fetching DB connections:', err);
    res.status(500).json({ error: 'Failed to fetch database connections' });
  }
});

// POST /api/v1/db-connections
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { projectId, name, engine, host, port, database, username, password, ssl } = req.body;
    if (!projectId || !name || !engine || !host || !port || !database || !username || !password) {
      return res.status(400).json({ error: 'Missing required connection fields' });
    }
    if (!ENGINES.includes(engine)) {
      return res.status(400).json({ error: `engine must be one of: ${ENGINES.join(', ')}` });
    }

    const { data: connection, error } = await supabase
      .from('DbConnection')
      .insert({
        projectId,
        name,
        engine,
        host,
        port: Number(port),
        database,
        username,
        encryptedPassword: encrypt(password),
        ssl: ssl !== undefined ? !!ssl : true,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(toSafeConnection(connection));
  } catch (err: any) {
    console.error('Error creating DB connection:', err);
    res.status(500).json({ error: 'Failed to create database connection' });
  }
});

// DELETE /api/v1/db-connections/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { error } = await supabase.from('DbConnection').delete().eq('id', req.params.id as string);
    if (error) throw error;
    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting DB connection:', err);
    res.status(500).json({ error: 'Failed to delete database connection' });
  }
});

// POST /api/v1/db-connections/:id/test
// Attempts a connection + trivial query, reports success/failure without persisting anything.
router.post('/:id/test', async (req: AuthRequest, res) => {
  const driver_holder: { driver: any } = { driver: null };
  try {
    const { data: connection, error } = await supabase.from('DbConnection').select('*').eq('id', req.params.id as string).maybeSingle();
    if (error) throw error;
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const password = decrypt(connection.encryptedPassword);
    const driver = createDriver(connection.engine);
    driver_holder.driver = driver;
    await driver.connect({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      password,
      ssl: connection.ssl,
    });

    res.json({ success: true, message: 'Connection verified successfully.' });
  } catch (err: any) {
    console.error('DB connection test failed:', err);
    res.status(400).json({ success: false, error: err.message || 'Connection failed' });
  } finally {
    await driver_holder.driver?.close().catch(() => {});
  }
});

// GET /api/v1/db-connections/:id/schema
// Read-only schema introspection — tables/columns/foreign keys for SQL
// engines, or sampled/inferred collection shapes for MongoDB. Always
// computed live (never cached), since a stale schema would actively
// mislead a testing tool.
router.get('/:id/schema', async (req: AuthRequest, res) => {
  try {
    const { data: connection, error } = await supabase.from('DbConnection').select('*').eq('id', req.params.id as string).maybeSingle();
    if (error) throw error;
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const schema = await introspectSchema(connection);
    res.json(schema);
  } catch (err: any) {
    console.error('Schema introspection failed:', err);
    res.status(500).json({ error: err.message || 'Failed to introspect schema' });
  }
});

export default router;
