import { useState } from "react";

const DRIVER_BY_TYPE = {
  postgres: "org.postgresql.Driver",
  mysql: "com.mysql.cj.jdbc.Driver",
};

export default function GlueJobPreview({ dbType, connection, onGenerate, script, loading, error }) {
  const [jdbcHost, setJdbcHost] = useState(connection?.host || "");
  const [jdbcPort, setJdbcPort] = useState(String(connection?.port || ""));
  const [jdbcDb, setJdbcDb] = useState(connection?.database || "");
  const [jdbcUser, setJdbcUser] = useState(connection?.user || "");
  const [secretName, setSecretName] = useState("prod/jdbc/password");
  const [mongoUri, setMongoUri] = useState("mongodb+srv://<cluster-uri>");
  const [mongoDb, setMongoDb] = useState("migrated_db");

  function buildJdbcUrl() {
    if (dbType === "postgres") {
      return `jdbc:postgresql://${jdbcHost}:${jdbcPort}/${jdbcDb}`;
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

      <button className="btn" onClick={handleGenerate} disabled={loading}>
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
