/**
 * Introspects a relational database (Postgres or MySQL) and returns a
 * normalized schema description:
 *
 * {
 *   tables: [
 *     {
 *       name: "customers",
 *       // `bsonType` is a suggested target MongoDB/BSON type inferred from
 *       // `dataType` (see bsonTypeMapper.js) -- editable by the user in the
 *       // Schema step; introspect() only ever sets the inferred default.
 *       // `bsonTypeConfident` is false when dataType wasn't recognized and
 *       // the "string" fallback was used.
 *       columns: [{ name, dataType, nullable, isPrimaryKey, bsonType, bsonTypeConfident }],
 *       primaryKey: ["id"],
 *       // `unique` is true when `column` is covered by a single-column
 *       // UNIQUE or PRIMARY KEY constraint on this table, i.e. the FK
 *       // relationship is one-to-one/one-to-zero rather than one-to-many.
 *       // `synthetic` (added by the UI, never set by introspect() itself)
 *       // marks a relationship the user manually declared because no real
 *       // FK constraint exists in the source database for it.
 *       foreignKeys: [{ column, refTable, refColumn, unique, synthetic }]
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
const { inferDefaultBsonType } = require("./bsonTypeMapper");

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

    const uniqueRes = await client.query(`
      SELECT
        tc.table_name       AS table_name,
        tc.constraint_name  AS constraint_name,
        kcu.column_name     AS column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
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
    }, buildSingleColumnUniqueSets(uniqueRes.rows, {
      table: "table_name",
      constraint: "constraint_name",
      column: "column_name",
    }));
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

    const [uniqueRows] = await conn.execute(
      `
      SELECT
        tc.TABLE_NAME      AS table_name,
        tc.CONSTRAINT_NAME AS constraint_name,
        kcu.COLUMN_NAME    AS column_name
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE IN ('UNIQUE', 'PRIMARY KEY')
        AND tc.TABLE_SCHEMA = ?;
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
    }, buildSingleColumnUniqueSets(uniqueRows, {
      table: "table_name",
      constraint: "constraint_name",
      column: "column_name",
    }));
  } finally {
    await conn.end();
  }
}

// Groups constraint rows by (table, constraint) to find constraints that
// cover exactly one column — those are the ones that make a FK column
// unique (and so the relationship one-to-one rather than one-to-many).
// Multi-column constraints don't make any single column in them unique on
// its own, so they're intentionally excluded.
function buildSingleColumnUniqueSets(rows, keys) {
  const constraints = new Map();
  for (const row of rows) {
    const constraintName = row[keys.constraint];
    if (!constraints.has(constraintName)) {
      constraints.set(constraintName, { table: row[keys.table], columns: new Set() });
    }
    constraints.get(constraintName).columns.add(row[keys.column]);
  }

  const uniqueSingleColumnsByTable = new Map();
  for (const { table: tableName, columns } of constraints.values()) {
    if (columns.size !== 1) continue;
    if (!uniqueSingleColumnsByTable.has(tableName)) {
      uniqueSingleColumnsByTable.set(tableName, new Set());
    }
    uniqueSingleColumnsByTable.get(tableName).add([...columns][0]);
  }
  return uniqueSingleColumnsByTable;
}

function buildSchema(columnRows, fkRows, keys, uniqueSingleColumnsByTable = new Map()) {
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
    const { bsonType, confident } = inferDefaultBsonType(row[keys.dataType]);
    table.columns.push({
      name: row[keys.column],
      dataType: row[keys.dataType],
      nullable: row[keys.nullable] === keys.nullableTrueValue,
      isPrimaryKey: isPk,
      bsonType,
      // False when dataType wasn't recognized and the "string" fallback was
      // used -- lets the UI flag a guess instead of presenting it as if it
      // were a confirmed mapping.
      bsonTypeConfident: confident,
    });
    if (isPk) table.primaryKey.push(row[keys.column]);
  }

  for (const row of fkRows) {
    const table = tableMap.get(row[keys.table]);
    if (!table) continue;
    const fkColumn = row[keys.fkColumn];
    const uniqueColumns = uniqueSingleColumnsByTable.get(row[keys.table]);
    table.foreignKeys.push({
      column: fkColumn,
      refTable: row[keys.fkRefTable],
      refColumn: row[keys.fkRefColumn],
      unique: Boolean(uniqueColumns && uniqueColumns.has(fkColumn)),
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
