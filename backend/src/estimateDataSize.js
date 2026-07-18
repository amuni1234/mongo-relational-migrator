/**
 * Cheap size/row estimates for a set of tables, used to suggest Spark/Glue
 * runtime sizing (see sparkConfigSuggester.js) -- not a full introspection,
 * just enough to size a job before running it.
 *
 * Row counts prefer each engine's free, already-maintained statistics
 * (Postgres's pg_class.reltuples, MySQL's information_schema.tables'
 * TABLE_ROWS) over a real COUNT(*) -- but those go stale, and Postgres
 * specifically returns -1 for a table that's never been ANALYZE'd (true,
 * confirmed live, for every table in this project's own seeded test
 * database). A real COUNT(*) is only run as a fallback, and only for
 * tables where the free estimate is actually unusable -- not
 * unconditionally, since that's the expensive query the free path exists
 * to avoid. Byte size (pg_total_relation_size / data_length+index_length)
 * doesn't have this staleness problem and is always used as-is.
 */

const { Client } = require("pg");
const mysql = require("mysql2/promise");

async function estimatePostgres(connectionConfig, tableNames) {
  const client = new Client(connectionConfig);
  await client.connect();
  try {
    const res = await client.query(
      `
      SELECT relname AS table_name,
             reltuples::bigint AS row_estimate,
             pg_total_relation_size(oid) AS size_bytes
      FROM pg_class
      WHERE relkind = 'r'
        AND relnamespace = 'public'::regnamespace
        AND relname = ANY($1::text[]);
      `,
      [tableNames]
    );
    const byName = new Map(res.rows.map((r) => [r.table_name, r]));

    const tables = [];
    for (const name of tableNames) {
      const row = byName.get(name);
      let rowEstimate = row ? Number(row.row_estimate) : 0;
      const sizeBytes = row ? Number(row.size_bytes) : 0;
      if (rowEstimate <= 0) {
        // Free estimate unavailable (never ANALYZE'd) -- fall back to a
        // real count for this one table only.
        const countRes = await client.query(`SELECT COUNT(*)::bigint AS n FROM "${name}"`);
        rowEstimate = Number(countRes.rows[0].n);
      }
      tables.push({ name, rowEstimate, sizeBytes });
    }
    return tables;
  } finally {
    await client.end();
  }
}

async function estimateMysql(connectionConfig, tableNames) {
  const conn = await mysql.createConnection(connectionConfig);
  try {
    // .query() (text protocol), not .execute() (prepared statements) --
    // mysql2's prepared-statement binary protocol can't bind a single "?"
    // to multiple values for an IN clause the way .query()'s escaping can.
    const [rows] = await conn.query(
      `
      SELECT TABLE_NAME AS table_name,
             TABLE_ROWS AS row_estimate,
             (DATA_LENGTH + INDEX_LENGTH) AS size_bytes
      FROM information_schema.tables
      WHERE table_schema = ? AND TABLE_NAME IN (?);
      `,
      [connectionConfig.database, tableNames]
    );
    const byName = new Map(rows.map((r) => [r.table_name, r]));

    const tables = [];
    for (const name of tableNames) {
      const row = byName.get(name);
      let rowEstimate = row ? Number(row.row_estimate) : 0;
      const sizeBytes = row ? Number(row.size_bytes) : 0;
      if (rowEstimate <= 0) {
        const [countRows] = await conn.execute(`SELECT COUNT(*) AS n FROM \`${name}\``);
        rowEstimate = Number(countRows[0].n);
      }
      tables.push({ name, rowEstimate, sizeBytes });
    }
    return tables;
  } finally {
    await conn.end();
  }
}

async function estimateDataSize(dbType, connectionConfig, tableNames) {
  const tables =
    dbType === "postgres"
      ? await estimatePostgres(connectionConfig, tableNames)
      : await estimateMysql(connectionConfig, tableNames);

  const totalSizeBytes = tables.reduce((sum, t) => sum + t.sizeBytes, 0);
  const totalRowEstimate = tables.reduce((sum, t) => sum + t.rowEstimate, 0);
  return { tables, totalSizeBytes, totalRowEstimate };
}

module.exports = { estimateDataSize };
