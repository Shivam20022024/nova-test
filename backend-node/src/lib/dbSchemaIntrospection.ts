import { decrypt } from './crypto';
import { PostgresDriver } from './dbDrivers/postgres';
import { MysqlDriver } from './dbDrivers/mysql';
import { MongoDriver } from './dbDrivers/mongo';
import { extractShape } from './schemaDrift';

export interface DbSchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface DbSchemaForeignKey {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface DbSchemaTable {
  name: string;
  columns: DbSchemaColumn[];
  foreignKeys: DbSchemaForeignKey[];
}

export interface DbSchema {
  tables: DbSchemaTable[];
}

interface ConnectionRecord {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  encryptedPassword: string;
  ssl: boolean;
}

async function introspectSql(connection: ConnectionRecord, driver: PostgresDriver | MysqlDriver): Promise<DbSchema> {
  const password = decrypt(connection.encryptedPassword);
  await driver.connect({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    password,
    ssl: connection.ssl,
  });

  const columnsResult = await driver.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = ${connection.engine === 'mysql' ? 'DATABASE()' : "'public'"}
     ORDER BY table_name, ordinal_position`,
    [],
    10000,
    5000
  );

  const pkResult = await driver.query(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = ${connection.engine === 'mysql' ? 'DATABASE()' : "'public'"}`,
    [],
    10000,
    5000
  );

  let fkRows: any[] = [];
  try {
    if (connection.engine === 'mysql') {
      const fkResult = await driver.query(
        `SELECT table_name, column_name, referenced_table_name AS references_table, referenced_column_name AS references_column
         FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`,
        [],
        10000,
        5000
      );
      fkRows = fkResult.rows;
    } else {
      const fkResult = await driver.query(
        `SELECT
           tc.table_name,
           kcu.column_name,
           ccu.table_name AS references_table,
           ccu.column_name AS references_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
        [],
        10000,
        5000
      );
      fkRows = fkResult.rows;
    }
  } catch {
    fkRows = []; // FK introspection is best-effort — never block the rest of the schema
  }

  const pkSet = new Set(pkResult.rows.map((r: any) => `${r.table_name}.${r.column_name}`));
  const tablesMap = new Map<string, DbSchemaTable>();

  for (const row of columnsResult.rows) {
    const tableName = row.table_name;
    if (!tablesMap.has(tableName)) tablesMap.set(tableName, { name: tableName, columns: [], foreignKeys: [] });
    tablesMap.get(tableName)!.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: String(row.is_nullable).toUpperCase() === 'YES',
      isPrimaryKey: pkSet.has(`${tableName}.${row.column_name}`),
    });
  }

  for (const row of fkRows) {
    const table = tablesMap.get(row.table_name);
    if (table) {
      table.foreignKeys.push({
        column: row.column_name,
        referencesTable: row.references_table,
        referencesColumn: row.references_column,
      });
    }
  }

  return { tables: Array.from(tablesMap.values()) };
}

async function introspectMongo(connection: ConnectionRecord, driver: MongoDriver): Promise<DbSchema> {
  const password = decrypt(connection.encryptedPassword);
  await driver.connect({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    password,
    ssl: connection.ssl,
  });

  // MongoDB has no fixed schema — sample each collection and infer field
  // shapes with the same extractShape used for schema-drift detection.
  const collections = await driver.listCollections();

  const tables: DbSchemaTable[] = [];
  for (const collName of collections) {
    const sample = await driver.query(collName, 'find', {}, undefined, 10000, 20);
    const shape = extractShape(sample.rows);
    const columns: DbSchemaColumn[] = [];
    if (shape.t === 'array' && shape.items.t === 'object') {
      for (const [name, fieldShape] of Object.entries(shape.items.keys)) {
        columns.push({ name, dataType: (fieldShape as any).t, nullable: true, isPrimaryKey: name === '_id' });
      }
    }
    tables.push({ name: collName, columns, foreignKeys: [] });
  }

  return { tables };
}

export async function introspectSchema(connection: ConnectionRecord): Promise<DbSchema> {
  if (connection.engine === 'mysql') {
    const driver = new MysqlDriver();
    try {
      return await introspectSql(connection, driver);
    } finally {
      await driver.close();
    }
  }
  if (connection.engine === 'mongodb') {
    const driver = new MongoDriver();
    try {
      return await introspectMongo(connection, driver);
    } finally {
      await driver.close();
    }
  }
  const driver = new PostgresDriver();
  try {
    return await introspectSql(connection, driver);
  } finally {
    await driver.close();
  }
}
