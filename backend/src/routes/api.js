const express = require("express");
const { introspect } = require("../introspect");
const { suggestMapping } = require("../schemaMapper");
const { generateGlueJob } = require("../generators/glueJobGenerator");
const { testLoad } = require("../mongoLoader");
const { validateComputedExpression } = require("../validateComputedExpression");
const { runLocal } = require("../runLocal");
const { estimateDataSize } = require("../estimateDataSize");
const { suggestSparkConfig } = require("../sparkConfigSuggester");

const router = express.Router();

/**
 * GET /api/mongo-defaults
 * -> { uri, database }
 * Lets the frontend prefill the test-load / Glue job Mongo fields from the
 * backend's own .env instead of the user retyping a connection string
 * (which may contain credentials) into the browser each time.
 */
router.get("/mongo-defaults", (req, res) => {
  res.json({
    uri: process.env.MONGODB_URI || "",
    database: process.env.MONGODB_DB || "",
  });
});

/**
 * POST /api/introspect
 * body: { dbType: "postgres" | "mysql", connection: {...driver config} }
 * -> { tables: [...] }
 */
router.post("/introspect", async (req, res) => {
  try {
    const { dbType, connection } = req.body;
    if (!dbType || !connection) {
      return res.status(400).json({ error: "dbType and connection are required" });
    }
    const schema = await introspect(dbType, connection);
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/suggest-mapping
 * body: { schema: {...introspect result} }
 * -> { collections: [...] }  (editable starting point for the UI)
 */
router.post("/suggest-mapping", (req, res) => {
  try {
    const { schema } = req.body;
    if (!schema) return res.status(400).json({ error: "schema is required" });
    const mapping = suggestMapping(schema);
    res.json(mapping);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/generate-glue-job
 * body: { jdbc: {...}, mongo: {...}, schema: {...}, mapping: {...}, loadMode?: "full" | "incremental",
 *         perf?: {driverMemory, executorMemory, executorCores, executorInstances, glueWorkerType?, glueNumberOfWorkers?} }
 * -> { script: "<python source>" }
 */
router.post("/generate-glue-job", (req, res) => {
  try {
    const { jdbc, mongo, schema, mapping, loadMode, perf } = req.body;
    if (!jdbc || !mongo || !schema || !mapping) {
      return res
        .status(400)
        .json({ error: "jdbc, mongo, schema, and mapping are all required" });
    }
    const script = generateGlueJob({ jdbc, mongo, schema, mapping, loadMode, perf });
    res.json({ script });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/test-load
 * body: { uri, database, collection, documents: [...] }
 * -> { insertedCount, totalInCollection, sample }
 */
router.post("/test-load", async (req, res) => {
  try {
    const { uri, database, collection, documents } = req.body;
    if (!uri || !database || !collection || !Array.isArray(documents)) {
      return res.status(400).json({
        error: "uri, database, collection, and documents[] are required",
      });
    }
    const result = await testLoad({ uri, database, collection, documents });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/validate-computed-expression
 * body: { dbType, connection: {...driver config}, table, expression, bsonType }
 * -> { valid: true } | { valid: false, error: "<real Spark error message>" }
 *
 * Real dry-run against the user's actual table via a throwaway local Spark
 * job (same Docker Glue image scripts/test-local-glue.sh uses) -- slower
 * than a heuristic check (~5-15s Spark cold start) but far more trustworthy.
 * A 500 here means validation itself couldn't run (Docker/DB unreachable),
 * not that the expression is wrong -- the frontend treats these two cases
 * differently ("invalid expression" vs. "couldn't check at all").
 */
router.post("/validate-computed-expression", async (req, res) => {
  try {
    const { dbType, connection, table, expression, bsonType } = req.body;
    if (!dbType || !connection || !table || !expression) {
      return res
        .status(400)
        .json({ error: "dbType, connection, table, and expression are all required" });
    }
    const result = await validateComputedExpression({ dbType, connection, table, expression, bsonType });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/run-local
 * body: { dbType, jdbc: {...}, mongo: {...}, schema: {...}, mapping: {...},
 *         loadMode?, engine: "glue" | "emr-serverless" | "emr-eks",
 *         perf?: {driverMemory, executorMemory, executorCores, executorInstances} }
 * -> { engine, success, log }
 *
 * One-click version of the manual scripts/test-local-glue.sh workflow --
 * generates the real script, swaps its Secrets Manager block for a local
 * env var (and, for "emr", swaps the Glue scaffold for plain PySpark too),
 * then actually runs it in a local Docker container against whatever
 * Postgres/MySQL + MongoDB the request's connection info points at
 * (localhost is automatically rewritten to host.docker.internal). No cloud
 * credentials, no billing -- purely local. A 500 means the run
 * infrastructure itself failed (Docker missing/unreachable), not that the
 * job failed -- a real job failure comes back as 200 with `success: false`
 * and the log tail explaining why.
 */
router.post("/run-local", async (req, res) => {
  try {
    const { dbType, jdbc, mongo, schema, mapping, loadMode, engine, perf } = req.body;
    if (!dbType || !jdbc || !mongo || !schema || !mapping || !engine) {
      return res
        .status(400)
        .json({ error: "dbType, jdbc, mongo, schema, mapping, and engine are all required" });
    }
    const result = await runLocal({ dbType, jdbc, mongo, schema, mapping, loadMode, engine, perf });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/estimate-size
 * body: { dbType, connection: {...driver config}, tableNames: [...] }
 * -> { tables: [{name, rowEstimate, sizeBytes}], totalSizeBytes,
 *      totalRowEstimate, suggested: {driverMemory, executorMemory,
 *      executorCores, executorInstances, glueWorkerType,
 *      glueNumberOfWorkers, bracket} }
 *
 * Cheap real queries against the source DB (pg_class / information_schema),
 * with a bounded COUNT(*) fallback only for tables with no usable free
 * estimate -- see estimateDataSize.js. Used to pre-fill the Glue-job step's
 * "Performance settings", always manually overridable from there.
 */
router.post("/estimate-size", async (req, res) => {
  try {
    const { dbType, connection, tableNames } = req.body;
    if (!dbType || !connection || !Array.isArray(tableNames) || tableNames.length === 0) {
      return res
        .status(400)
        .json({ error: "dbType, connection, and a non-empty tableNames[] are all required" });
    }
    const size = await estimateDataSize(dbType, connection, tableNames);
    res.json({ ...size, suggested: suggestSparkConfig(size.totalSizeBytes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
