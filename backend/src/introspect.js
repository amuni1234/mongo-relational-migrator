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
 *       // `columns`/`refColumns` are always arrays, in corresponding order
 *       // (columns[i] on this table maps to refColumns[i] on refTable) --
 *       // length 1 for an ordinary single-column FK, length N for a
 *       // composite (multi-column) FK.
 *       // `unique` is true when this FK's exact column set (as a set, any
 *       // order) is covered by a UNIQUE or PRIMARY KEY constraint on this
 *       // table, i.e. the relationship is one-to-one/one-to-zero rather
 *       // than one-to-many.
 *       // `synthetic` (added by the UI, never set by introspect() itself)
 *       // marks a relationship the user manually declared because no real
 *       // FK constraint exists in the source database for it.
 *       foreignKeys: [{ columns, refTable, refColumns, unique, synthetic }]
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

    // information_schema's table_constraints/key_column_usage/
    // constraint_column_usage 3-way join (joined only on constraint_name)
    // produces a CARTESIAN PRODUCT for a composite FK -- nothing correlates
    // *which* source column pairs with *which* referenced column, so a
    // 2-column FK yields 2x2=4 rows instead of 2 correctly-paired ones
    // (confirmed empirically). pg_constraint's conkey/confkey arrays,
    // unnested WITH ORDINALITY and joined on matching ordinal position, is
    // the reliable way to extract correctly-paired composite FK columns.
    const fkRes = await client.query(`
      SELECT
        con.conrelid::regclass::text AS table_name,
        att2.attname AS column_name,
        con.confrelid::regclass::text AS ref_table,
        att1.attname AS ref_column,
        con.conname AS constraint_name,
        ak.ord AS ordinal
      FROM pg_constraint con
      JOIN unnest(con.conkey) WITH ORDINALITY AS ak(attnum, ord) ON true
      JOIN unnest(con.confkey) WITH ORDINALITY AS confk(attnum, ord) ON ak.ord = confk.ord
      JOIN pg_attribute att2 ON att2.attrelid = con.conrelid AND att2.attnum = ak.attnum
      JOIN pg_attribute att1 ON att1.attrelid = con.confrelid AND att1.attnum = confk.attnum
      WHERE con.contype = 'f'
        AND con.connamespace = 'public'::regnamespace;
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
      fkConstraint: "constraint_name",
      fkOrdinal: "ordinal",
      nullableTrueValue: "YES",
    }, buildUniqueColumnSets(uniqueRes.rows, {
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

    // MySQL's key_column_usage already correctly pairs column_name with
    // referenced_column_name per row (no cartesian-product risk here,
    // unlike Postgres's information_schema) -- just need the constraint
    // name + ordinal position too, to group/order composite FKs correctly.
    const [fks] = await conn.execute(
      `
      SELECT
        TABLE_NAME             AS table_name,
        COLUMN_NAME            AS column_name,
        REFERENCED_TABLE_NAME  AS ref_table,
        REFERENCED_COLUMN_NAME AS ref_column,
        CONSTRAINT_NAME        AS constraint_name,
        ORDINAL_POSITION       AS ordinal
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
      fkConstraint: "constraint_name",
      fkOrdinal: "ordinal",
      nullableTrueValue: "YES",
    }, buildUniqueColumnSets(uniqueRows, {
      table: "table_name",
      constraint: "constraint_name",
      column: "column_name",
    }));
  } finally {
    await conn.end();
  }
}

// Groups constraint rows by (table, constraint) into one column-set per
// constraint, regardless of size -- a composite unique/PK constraint's
// column set is tracked in full (not discarded the way single-column-only
// tracking would), since a composite FK's uniqueness has to be checked
// against the FK's *entire* column set, not any one column in isolation.
function buildUniqueColumnSets(rows, keys) {
  const constraints = new Map(); // constraintName -> { table, columns: Set }
  for (const row of rows) {
    const constraintName = row[keys.constraint];
    if (!constraints.has(constraintName)) {
      constraints.set(constraintName, { table: row[keys.table], columns: new Set() });
    }
    constraints.get(constraintName).columns.add(row[keys.column]);
  }

  const uniqueColumnSetsByTable = new Map(); // tableName -> Set<string>[] (one Set per constraint)
  for (const { table: tableName, columns } of constraints.values()) {
    if (!uniqueColumnSetsByTable.has(tableName)) uniqueColumnSetsByTable.set(tableName, []);
    uniqueColumnSetsByTable.get(tableName).push(columns);
  }
  return uniqueColumnSetsByTable;
}

// Does `columns` (as a set, any order) exactly match one of this table's
// unique/PK constraint column sets?
function isColumnSetUnique(uniqueColumnSetsByTable, tableName, columns) {
  const sets = uniqueColumnSetsByTable.get(tableName);
  if (!sets) return false;
  const target = new Set(columns);
  return sets.some((set) => set.size === target.size && [...set].every((c) => target.has(c)));
}

// Groups FK rows by constraint name into one entry per constraint (instead
// of one entry per column), ordered by ordinal position so columns[i] on
// this table always corresponds to refColumns[i] on refTable.
function buildForeignKeyGroups(fkRows, keys) {
  const constraints = new Map(); // constraintName -> { table, refTable, pairs: [{column, refColumn, ordinal}] }
  for (const row of fkRows) {
    const name = row[keys.fkConstraint];
    if (!constraints.has(name)) {
      constraints.set(name, {
        table: row[keys.table],
        refTable: row[keys.fkRefTable],
        pairs: [],
      });
    }
    constraints.get(name).pairs.push({
      column: row[keys.fkColumn],
      refColumn: row[keys.fkRefColumn],
      ordinal: row[keys.fkOrdinal],
    });
  }

  return Array.from(constraints.values()).map(({ table, refTable, pairs }) => {
    const ordered = [...pairs].sort((a, b) => a.ordinal - b.ordinal);
    return {
      table,
      refTable,
      columns: ordered.map((p) => p.column),
      refColumns: ordered.map((p) => p.refColumn),
    };
  });
}

function buildSchema(columnRows, fkRows, keys, uniqueColumnSetsByTable = new Map()) {
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

  for (const group of buildForeignKeyGroups(fkRows, keys)) {
    const table = tableMap.get(group.table);
    if (!table) continue;
    table.foreignKeys.push({
      columns: group.columns,
      refTable: group.refTable,
      refColumns: group.refColumns,
      unique: isColumnSetUnique(uniqueColumnSetsByTable, group.table, group.columns),
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
