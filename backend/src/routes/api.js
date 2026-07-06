const express = require("express");
const { introspect } = require("../introspect");
const { suggestMapping } = require("../schemaMapper");
const { generateGlueJob } = require("../generators/glueJobGenerator");
const { testLoad } = require("../mongoLoader");

const router = express.Router();

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
 * body: { jdbc: {...}, mongo: {...}, schema: {...}, mapping: {...} }
 * -> { script: "<python source>" }
 */
router.post("/generate-glue-job", (req, res) => {
  try {
    const { jdbc, mongo, schema, mapping } = req.body;
    if (!jdbc || !mongo || !schema || !mapping) {
      return res
        .status(400)
        .json({ error: "jdbc, mongo, schema, and mapping are all required" });
    }
    const script = generateGlueJob({ jdbc, mongo, schema, mapping });
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

module.exports = router;
