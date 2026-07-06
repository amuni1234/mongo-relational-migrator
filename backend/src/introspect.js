/**
 * Introspects a relational database (Postgres or MySQL) and returns a
 * normalized schema description:
 *
 * {
 *   tables: [
 *     {
 *       name: "customers",
 *       columns: [{ name, dataType, nullable, isPrimaryKey }],
 *       primaryKey: ["id"],
 *       foreignKeys: [{ column, refTable, refColumn }]
 *     },
 *     ...
 *   ]
 * }
 *
 * This normalized shape is what the frontend renders and what the mapping
 * editor + Glue job generator consume, so the rest of the app never has to
 * care whether the source was Postgres or MySQL.
 */

const { Client } = require("pg");
const mysql = require("mysql2/promise");

async function introspectPostgres(connectionConfig) {
  const client = new Client(connectionConfig);
  await client.connect();

  try {
    const columnsRes = await client.query(`
      SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        (
          SELECT COUNT(*) > 0
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name
        ) AS is_primary_key
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position;
    `);

    const fkRes = await client.query(`
      SELECT
        tc.table_name   AS table_name,
        kcu.column_name AS column_name,
        ccu.table_name  AS ref_table,
        ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public';
    `);

    return buildSchema(columnsRes.rows, fkRes.rows, {
      table: "table_name",
      column: "column_name",
      dataType: "data_type",
      nullable: "is_nullable",
      isPk: "is_primary_key",
      fkColumn: "column_name",
      fkRefTable: "ref_table",
      fkRefColumn: "ref_column",
      nullableTrueValue: "YES",
    });
  } finally {
    await client.end();
  }
}

async function introspectMysql(connectionConfig) {
  const conn = await mysql.createConnection(connectionConfig);

  try {
    const [columns] = await conn.execute(
      `
      SELECT
        TABLE_NAME   AS table_name,
        COLUMN_NAME  AS column_name,
        DATA_TYPE    AS data_type,
        IS_NULLABLE  AS is_nullable,
        COLUMN_KEY   AS column_key
      FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION;
      `,
      [connectionConfig.database]
    );

    const [fks] = await conn.execute(
      `
      SELECT
        TABLE_NAME            AS table_name,
        COLUMN_NAME           AS column_name,
        REFERENCED_TABLE_NAME AS ref_table,
        REFERENCED_COLUMN_NAME AS ref_column
      FROM information_schema.key_column_usage
      WHERE table_schema = ?
        AND referenced_table_name IS NOT NULL;
      `,
      [connectionConfig.database]
    );

    const normalizedColumns = columns.map((c) => ({
      ...c,
      is_primary_key: c.column_key === "PRI",
    }));

    return buildSchema(normalizedColumns, fks, {
      table: "table_name",
      column: "column_name",
      dataType: "data_type",
      nullable: "is_nullable",
      isPk: "is_primary_key",
      fkColumn: "column_name",
      fkRefTable: "ref_table",
      fkRefColumn: "ref_column",
      nullableTrueValue: "YES",
    });
  } finally {
    await conn.end();
  }
}

function buildSchema(columnRows, fkRows, keys) {
  const tableMap = new Map();

  for (const row of columnRows) {
    const tableName = row[keys.table];
    if (!tableMap.has(tableName)) {
      tableMap.set(tableName, {
        name: tableName,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
      });
    }
    const table = tableMap.get(tableName);
    const isPk = row[keys.isPk] === true || row[keys.isPk] === 1;
    table.columns.push({
      name: row[keys.column],
      dataType: row[keys.dataType],
      nullable: row[keys.nullable] === keys.nullableTrueValue,
      isPrimaryKey: isPk,
    });
    if (isPk) table.primaryKey.push(row[keys.column]);
  }

  for (const row of fkRows) {
    const table = tableMap.get(row[keys.table]);
    if (!table) continue;
    table.foreignKeys.push({
      column: row[keys.fkColumn],
      refTable: row[keys.fkRefTable],
      refColumn: row[keys.fkRefColumn],
    });
  }

  return { tables: Array.from(tableMap.values()) };
}

async function introspect(dbType, connectionConfig) {
  if (dbType === "postgres") return introspectPostgres(connectionConfig);
  if (dbType === "mysql") return introspectMysql(connectionConfig);
  throw new Error(`Unsupported dbType: ${dbType}. Use "postgres" or "mysql".`);
}

module.exports = { introspect };
