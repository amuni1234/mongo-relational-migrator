require("dotenv").config();
const express = require("express");
const cors = require("cors");
const apiRoutes = require("./src/routes/api");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use("/api", apiRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Migrator backend listening on http://localhost:${PORT}`);
});
