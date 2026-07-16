import { useState } from "react";

const DRIVER_BY_TYPE = {
  postgres: "org.postgresql.Driver",
  mysql: "com.mysql.cj.jdbc.Driver",
  mssql: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
};

export default function GlueJobPreview({ dbType, connection, schema, onGenerate, script, loading, error }) {
  const [jdbcHost, setJdbcHost] = useState(connection?.host || "");
  const [jdbcPort, setJdbcPort] = useState(String(connection?.port || ""));
  const [jdbcDb, setJdbcDb] = useState(connection?.database || "");
  const [jdbcUser, setJdbcUser] = useState(connection?.user || "");
  const [secretName, setSecretName] = useState("prod/jdbc/password");
  const [mongoUri, setMongoUri] = useState("mongodb+srv://<cluster-uri>");
  const [mongoDb, setMongoDb] = useState("migrated_db");

  // Full vs incremental load (feature: incremental sync via a watermark column)
  const [loadType, setLoadType] = useState("full");
  const allColumnNames = Array.from(
    new Set((schema?.tables || []).flatMap((t) => t.columns.map((c) => c.name)))
  ).sort();
  const [watermarkColumn, setWatermarkColumn] = useState(
    allColumnNames.find((c) => /updated_at|modified_at|placed_at/.test(c)) || allColumnNames[0] || ""
  );
  const [statePath, setStatePath] = useState("s3://your-bucket/migrator-state/job-name.json");

  function buildJdbcUrl() {
    if (dbType === "postgres") {
      return `jdbc:postgresql://${jdbcHost}:${jdbcPort}/${jdbcDb}`;
    }
    if (dbType === "mssql") {
      return `jdbc:sqlserver://${jdbcHost}:${jdbcPort};databaseName=${jdbcDb}`;
    }
    return `jdbc:mysql://${jdbcHost}:${jdbcPort}/${jdbcDb}`;
  }

  function handleGenerate() {
    onGenerate({
      jdbc: {
        url: buildJdbcUrl(),
        user: jdbcUser,
        driver: DRIVER_BY_TYPE[dbType],
        passwordSecretName: secretName,
      },
      mongo: {
        uri: mongoUri,
        database: mongoDb,
      },
      loadStrategy:
        loadType === "incremental"
          ? { type: "incremental", watermarkColumn, statePath }
          : { type: "full" },
    });
  }

  function download() {
    const blob = new Blob([script], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "glue_relational_to_mongo_job.py";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="panel">
      <h2>4. Generate the AWS Glue job</h2>
      <p className="hint">
        Produces a Glue 4.0 PySpark script. Add the MongoDB Spark Connector
        as a job dependency and store the JDBC password in Secrets Manager
        under the name you give below — the script resolves it at runtime.
      </p>

      <div className="grid-2">
        <div>
          <label>JDBC host</label>
          <input type="text" value={jdbcHost} onChange={(e) => setJdbcHost(e.target.value)} />
        </div>
        <div>
          <label>JDBC port</label>
          <input type="text" value={jdbcPort} onChange={(e) => setJdbcPort(e.target.value)} />
        </div>
      </div>
      <label>JDBC database</label>
      <input type="text" value={jdbcDb} onChange={(e) => setJdbcDb(e.target.value)} />
      <div className="grid-2">
        <div>
          <label>JDBC user</label>
          <input type="text" value={jdbcUser} onChange={(e) => setJdbcUser(e.target.value)} />
        </div>
        <div>
          <label>Secrets Manager secret name (for JDBC password)</label>
          <input type="text" value={secretName} onChange={(e) => setSecretName(e.target.value)} />
        </div>
      </div>

      <div className="grid-2">
        <div>
          <label>MongoDB connection URI</label>
          <input type="text" value={mongoUri} onChange={(e) => setMongoUri(e.target.value)} />
        </div>
        <div>
          <label>MongoDB database</label>
          <input type="text" value={mongoDb} onChange={(e) => setMongoDb(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label>Load strategy</label>
        <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "normal" }}>
            <input
              type="radio"
              name="loadType"
              checked={loadType === "full"}
              onChange={() => setLoadType("full")}
            />
            Full load (overwrite every run)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "normal" }}>
            <input
              type="radio"
              name="loadType"
              checked={loadType === "incremental"}
              onChange={() => setLoadType("incremental")}
            />
            Incremental (only new/changed rows)
          </label>
        </div>

        {loadType === "incremental" && (
          <div className="grid-2">
            <div>
              <label>Watermark column</label>
              <select value={watermarkColumn} onChange={(e) => setWatermarkColumn(e.target.value)}>
                {allColumnNames.length === 0 && <option value="">(no schema loaded yet)</option>}
                {allColumnNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <p className="hint" style={{ marginTop: 4 }}>
                Only used for tables that actually have this column — other
                tables in the job still load in full.
              </p>
            </div>
            <div>
              <label>Watermark state location</label>
              <input
                type="text"
                value={statePath}
                onChange={(e) => setStatePath(e.target.value)}
                placeholder="s3://bucket/key.json"
              />
              <p className="hint" style={{ marginTop: 4 }}>
                Where the last-seen watermark per table is stored between
                runs. Use an S3 path for a real deployment.
              </p>
            </div>
          </div>
        )}
      </div>

      <button className="btn" onClick={handleGenerate} disabled={loading} style={{ marginTop: 12 }}>
        {loading ? "Generating…" : "Generate Glue script"}
      </button>

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {script && (
        <>
          <div className="toolbar" style={{ marginTop: 20 }}>
            <button className="btn secondary" onClick={download}>
              Download .py
            </button>
          </div>
          <pre className="code-preview">{script}</pre>
        </>
      )}
    </div>
  );
}