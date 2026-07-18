import { useEffect, useState } from "react";
import { api } from "../api";

const DRIVER_BY_TYPE = {
  postgres: "org.postgresql.Driver",
  mysql: "com.mysql.cj.jdbc.Driver",
};

const ENGINE_LABELS = {
  glue: "Glue",
  "emr-serverless": "EMR Serverless",
  "emr-eks": "EMR on EKS",
};

export default function GlueJobPreview({
  dbType,
  connection,
  onGenerate,
  script,
  loading,
  error,
  onRunLocal,
  runLoading,
  runResult,
  runError,
}) {
  const [jdbcHost, setJdbcHost] = useState(connection?.host || "");
  const [jdbcPort, setJdbcPort] = useState(String(connection?.port || ""));
  const [jdbcDb, setJdbcDb] = useState(connection?.database || "");
  const [jdbcUser, setJdbcUser] = useState(connection?.user || "");
  const [secretName, setSecretName] = useState("prod/jdbc/password");
  const [mongoUri, setMongoUri] = useState("mongodb+srv://<cluster-uri>");
  const [mongoDb, setMongoDb] = useState("migrated_db");
  const [loadMode, setLoadMode] = useState("full");
  const [engine, setEngine] = useState("glue");

  // Same prefill TestLoadPanel.jsx already does from the backend's own
  // .env -- the mongodb+srv://<cluster-uri> default is meant to be edited
  // before a real deploy, but is also a literal placeholder that crashes
  // "Run locally now" outright (Spark rejects it as an invalid SRV host)
  // if nobody happens to replace it first. Only overrides while the field
  // is still at its hardcoded default -- won't clobber anything typed in.
  useEffect(() => {
    api
      .mongoDefaults()
      .then(({ uri: defaultUri, database: defaultDatabase }) => {
        if (defaultUri) {
          setMongoUri((current) => (current === "mongodb+srv://<cluster-uri>" ? defaultUri : current));
        }
        if (defaultDatabase) {
          setMongoDb((current) => (current === "migrated_db" ? defaultDatabase : current));
        }
      })
      .catch(() => {}); // no .env defaults configured -- keep the hardcoded fallback
  }, []);

  function buildJdbcUrl() {
    if (dbType === "postgres") {
      return `jdbc:postgresql://${jdbcHost}:${jdbcPort}/${jdbcDb}`;
    }
    return `jdbc:mysql://${jdbcHost}:${jdbcPort}/${jdbcDb}`;
  }

  function buildJdbcAndMongo() {
    return {
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
    };
  }

  function handleGenerate() {
    onGenerate({ ...buildJdbcAndMongo(), loadMode });
  }

  function handleRunLocal() {
    onRunLocal({ ...buildJdbcAndMongo(), loadMode, engine });
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

      <label>Load mode</label>
      <span className="pill-toggle" style={{ marginBottom: 6 }}>
        <button className={loadMode === "full" ? "active" : ""} onClick={() => setLoadMode("full")}>
          Full (overwrite)
        </button>
        <button
          className={loadMode === "incremental" ? "active" : ""}
          onClick={() => setLoadMode("incremental")}
        >
          Incremental (upsert)
        </button>
        <button className={loadMode === "scd2" ? "active" : ""} onClick={() => setLoadMode("scd2")}>
          Incremental (SCD2)
        </button>
      </span>
      <p className="hint" style={{ marginTop: 4 }}>
        {loadMode === "full" &&
          "Drops/truncates each target collection before writing -- safe for a first load, destructive on re-runs."}
        {loadMode === "incremental" &&
          "Upserts by each collection's primary key -- safe to re-run, but doesn't delete target documents whose source row was deleted, and doesn't reduce how much is read from the source."}
        {loadMode === "scd2" &&
          "Preserves history instead of replacing in place -- a changed or new row gets a fresh current version, its prior version is kept and marked no-longer-current rather than overwritten. Still reads the full source table every run; writes nothing for rows that haven't changed."}
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

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>Run it locally now</h3>
            <p className="hint">
              Runs this exact script for real, right now, in a local Docker container
              against whatever Postgres/MySQL and MongoDB the fields above point at
              (localhost is automatically reached via <code>host.docker.internal</code>)
              -- no cloud account, no cost. Same mechanism as{" "}
              <code>scripts/test-local-glue.sh</code>, just one click instead of a
              terminal. <strong>Glue</strong> uses AWS's own local Glue 4.0 image
              (Postgres/Mongo drivers bundled). The two <strong>EMR</strong> options run
              plain PySpark in AWS's official EMR base images, with drivers resolved
              from Maven on first run (slower than Glue) -- <strong>Serverless</strong>{" "}
              is EMR's on-demand model, <strong>on EKS</strong> is EMR's Kubernetes-cluster
              model; both are equally real, just different EMR deployment products, so
              pick whichever matches what you'd actually run in production.
            </p>

            <span className="pill-toggle" style={{ marginBottom: 10 }}>
              <button className={engine === "glue" ? "active" : ""} onClick={() => setEngine("glue")}>
                Glue (Docker)
              </button>
              <button
                className={engine === "emr-serverless" ? "active" : ""}
                onClick={() => setEngine("emr-serverless")}
              >
                EMR Serverless (Docker)
              </button>
              <button className={engine === "emr-eks" ? "active" : ""} onClick={() => setEngine("emr-eks")}>
                EMR on EKS (Docker)
              </button>
            </span>

            <div>
              <button className="btn" onClick={handleRunLocal} disabled={runLoading}>
                {runLoading ? "Running… (can take a couple minutes)" : "Run locally now"}
              </button>
            </div>

            {runError && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                Couldn't run it at all: {runError}
              </div>
            )}

            {runResult && (
              <div style={{ marginTop: 12 }}>
                <div className={`status-line ${runResult.success ? "ok" : "error"}`}>
                  {runResult.success
                    ? `✓ Ran successfully via ${ENGINE_LABELS[runResult.engine]} -- check your MongoDB collections.`
                    : `✗ The job ran but failed via ${ENGINE_LABELS[runResult.engine]} -- see the log below.`}
                </div>
                <pre className="code-preview" style={{ maxHeight: 300, overflow: "auto" }}>
                  {runResult.log?.slice(-4000)}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
