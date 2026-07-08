require("dotenv").config();
const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const apiRoutes = require("./src/routes/api");
const openapiSpec = require("./openapi.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use("/api", apiRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Interactive API docs with "Try it out" for testing each endpoint in
// isolation, e.g. just /api/suggest-mapping's cardinality inference without
// going through the full wizard UI.
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Migrator backend listening on http://localhost:${PORT}`);
});
