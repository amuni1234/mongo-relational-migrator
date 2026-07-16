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
 *       // `unique` is true when `column` is covered by a single-column
 *       // UNIQUE or PRIMARY KEY constraint on this table, i.e. the FK
 *       // relationship is one-to-one/one-to-zero rather than one-to-many.
 *       foreignKeys: [{ column, refTable, refColumn, unique }]
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
const mssql = require("mssql");

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

async function introspectMssql(connectionConfig) {
  const pool = await mssql.connect({
    server: connectionConfig.host,
    port: connectionConfig.port,
    user: connectionConfig.user,
    password: connectionConfig.password,
    database: connectionConfig.database,
    options: { encrypt: connectionConfig.encrypt ?? true, trustServerCertificate: true },
  });

  try {
    const columnsRes = await pool.request().query(`
      SELECT
        c.TABLE_NAME  AS table_name,
        c.COLUMN_NAME AS column_name,
        c.DATA_TYPE   AS data_type,
        c.IS_NULLABLE AS is_nullable,
        CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT ku.TABLE_NAME, ku.COLUMN_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
          ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;
    `);

    const fkRes = await pool.request().query(`
      SELECT
        tc.TABLE_NAME                 AS table_name,
        kcu.COLUMN_NAME                AS column_name,
        rc_ku.TABLE_NAME               AS ref_table,
        rc_ku.COLUMN_NAME              AS ref_column
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
        ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE rc_ku
        ON rc.UNIQUE_CONSTRAINT_NAME = rc_ku.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY';
    `);

    const uniqueRes = await pool.request().query(`
      SELECT
        tc.TABLE_NAME      AS table_name,
        tc.CONSTRAINT_NAME AS constraint_name,
        kcu.COLUMN_NAME    AS column_name
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_TYPE IN ('UNIQUE', 'PRIMARY KEY');
    `);

    return buildSchema(columnsRes.recordset, fkRes.recordset, {
      table: "table_name",
      column: "column_name",
      dataType: "data_type",
      nullable: "is_nullable",
      isPk: "is_primary_key",
      fkColumn: "column_name",
      fkRefTable: "ref_table",
      fkRefColumn: "ref_column",
      nullableTrueValue: "YES",
    }, buildSingleColumnUniqueSets(uniqueRes.recordset, {
      table: "table_name",
      constraint: "constraint_name",
      column: "column_name",
    }));
  } finally {
    await pool.close();
  }
}


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
  if (dbType === "mssql") return introspectMssql(connectionConfig);
  // Roadmap, not yet implemented: Oracle and Snowflake need their own
  // driver + a different information_schema/system-catalog dialect. Rather
  // than fake support, we fail loudly so this doesn't look silently broken.
  if (dbType === "oracle" || dbType === "snowflake") {
    throw new Error(
      `dbType "${dbType}" is on the roadmap but not implemented yet. Supported today: postgres, mysql, mssql.`
    );
  }
  throw new Error(`Unsupported dbType: ${dbType}. Use "postgres", "mysql", or "mssql".`);
}

module.exports = { introspect };
