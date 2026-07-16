const express = require("express");
const { introspect } = require("../introspect");
const { suggestMapping } = require("../schemaMapper");
const { generateGlueJob } = require("../generators/glueJobGenerator");
const { testLoad } = require("../mongoLoader");
const { deployToAwsGlue } = require("../deploy/awsGlueDeployer");
const { deployToGcpDataproc } = require("../deploy/gcpDataprocDeployer");

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
 * body: { jdbc: {...}, mongo: {...}, schema: {...}, mapping: {...}, loadStrategy?: {...} }
 * -> { script: "<python source>" }
 */
router.post("/generate-glue-job", (req, res) => {
  try {
    const { jdbc, mongo, schema, mapping, loadStrategy } = req.body;
    if (!jdbc || !mongo || !schema || !mapping) {
      return res
        .status(400)
        .json({ error: "jdbc, mongo, schema, and mapping are all required" });
    }
    const script = generateGlueJob({ jdbc, mongo, schema, mapping, loadStrategy });
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
 * POST /api/deploy-job
 * body: { target: "aws-glue", script, jobName, region, s3Bucket, s3Key, roleArn, ... }
 *    or { target: "gcp-dataproc", ... }  (not yet implemented -> 501)
 * -> { jobName, jobRunId, consoleUrl, ... } for aws-glue
 */
router.post("/deploy-job", async (req, res) => {
  try {
    const { target, ...options } = req.body;
    if (!target) return res.status(400).json({ error: "target is required" });

    if (target === "aws-glue") {
      const result = await deployToAwsGlue(options);
      return res.json(result);
    }
    if (target === "gcp-dataproc") {
      const result = await deployToGcpDataproc(options);
      return res.json(result);
    }
    return res.status(400).json({ error: `Unknown deploy target: ${target}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
