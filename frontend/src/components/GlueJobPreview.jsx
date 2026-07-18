import { useState } from "react";
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
  workingSchema,
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
  // Defaults to the local Docker Mongo container (what "Run locally now"
  // actually needs to hit, zero cost) rather than a real Atlas cluster --
  // deliberately NOT prefilled from the backend's own .env the way
  // TestLoadPanel.jsx does, since that .env is a real remote Atlas cluster
  // (used for the separate "Test Load" step's own purpose) and pointing
  // "Run locally now" at a real cluster surfaces a real TLS/SNI
  // compatibility issue between the Glue container's bundled JDK and
  // Atlas, confirmed live -- unrelated to, and unfixable via, anything
  // this tool controls. Still just a starting point for the "Generate/
  // Download" flow too -- edit before a real deploy, same as before.
  const [mongoUri, setMongoUri] = useState("mongodb://localhost:27017");
  const [mongoDb, setMongoDb] = useState("migrator_test");
  const [loadMode, setLoadMode] = useState("full");
  const [engine, setEngine] = useState("glue");

  // Performance settings: pre-filled by "Suggest based on data size" (a
  // real query against the source DB, see estimateDataSize.js), always
  // manually editable afterward. null fields mean "not set yet" -- the
  // backend/generator simply omit perf entirely until a suggestion (or a
  // manual edit) actually populates them.
  const [driverMemory, setDriverMemory] = useState("");
  const [executorMemory, setExecutorMemory] = useState("");
  const [executorCores, setExecutorCores] = useState("");
  const [executorInstances, setExecutorInstances] = useState("");
  const [glueWorkerType, setGlueWorkerType] = useState("");
  const [glueNumberOfWorkers, setGlueNumberOfWorkers] = useState("");
  const [sizeHint, setSizeHint] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState(null);

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

  // Only included once all four fields are actually set (either by a
  // suggestion or by hand) -- omitting `perf` entirely is what keeps
  // generateGlueJob()'s output byte-identical to before this feature
  // existed for anyone who hasn't touched these fields.
  function buildPerf() {
    if (!driverMemory || !executorMemory || !executorCores || !executorInstances) return undefined;
    return {
      driverMemory,
      executorMemory,
      executorCores,
      executorInstances,
      glueWorkerType: glueWorkerType || undefined,
      glueNumberOfWorkers: glueNumberOfWorkers || undefined,
    };
  }

  async function handleSuggestSize() {
    setEstimateError(null);
    setEstimating(true);
    try {
      const tableNames = (workingSchema?.tables || []).map((t) => t.name);
      const result = await api.estimateSize({ dbType, connection, tableNames });
      setDriverMemory(result.suggested.driverMemory);
      setExecutorMemory(result.suggested.executorMemory);
      setExecutorCores(result.suggested.executorCores);
      setExecutorInstances(result.suggested.executorInstances);
      setGlueWorkerType(result.suggested.glueWorkerType);
      setGlueNumberOfWorkers(String(result.suggested.glueNumberOfWorkers));
      setSizeHint(
        `~${(result.totalSizeBytes / (1024 * 1024)).toFixed(1)} MB across ${result.tables.length} table${
          result.tables.length === 1 ? "" : "s"
        } (~${result.totalRowEstimate.toLocaleString()} rows) -- ${result.suggested.bracket} bracket`
      );
    } catch (err) {
      setEstimateError(err.message);
    } finally {
      setEstimating(false);
    }
  }

  function handleGenerate() {
    onGenerate({ ...buildJdbcAndMongo(), loadMode, perf: buildPerf() });
  }

  function handleRunLocal() {
    onRunLocal({ ...buildJdbcAndMongo(), loadMode, engine, perf: buildPerf() });
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

      <div style={{ marginTop: 10, marginBottom: 14, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <label style={{ margin: 0 }}>Performance settings (optional)</label>
        <p className="hint" style={{ marginTop: 2 }}>
          Four real Spark-submit flags -- driver/executor memory, executor cores, executor
          instances -- passed identically to a local run of any of the three engines below
          (Glue, EMR Serverless, EMR on EKS), since all three run via <code>spark-submit</code>.
          Confirmed live: locally, all three run in <code>local[*]</code> mode (driver and
          worker are the same single process), so only <strong>driver memory</strong>
          meaningfully changes what a local run actually does -- executor memory/cores/instances
          are accepted without error but have little practical effect until the downloaded script
          is deployed somewhere genuinely distributed, which is exactly why they're also written
          into that script's docstring as a suggestion. AWS Glue's own job-level
          WorkerType/NumberOfWorkers sizing is separate, informational-only -- that's a real Glue
          job's own Console/API setting, not anything this script controls. Leave every field
          blank to skip this entirely (nothing added to the script or the local run).
        </p>
        <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={handleSuggestSize} disabled={estimating}>
          {estimating ? "Estimating…" : "Suggest based on data size"}
        </button>
        {sizeHint && <div className="hint" style={{ marginTop: 4 }}>{sizeHint}</div>}
        {estimateError && (
          <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 4 }}>
            Couldn't estimate: {estimateError}
          </div>
        )}

        <div className="grid-2" style={{ marginTop: 8 }}>
          <div>
            <label>Driver memory</label>
            <input type="text" placeholder="e.g. 2g" value={driverMemory} onChange={(e) => setDriverMemory(e.target.value)} />
          </div>
          <div>
            <label>Executor memory</label>
            <input type="text" placeholder="e.g. 4g" value={executorMemory} onChange={(e) => setExecutorMemory(e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label>Executor cores</label>
            <input type="text" placeholder="e.g. 2" value={executorCores} onChange={(e) => setExecutorCores(e.target.value)} />
          </div>
          <div>
            <label>Executor instances</label>
            <input type="text" placeholder="e.g. 2" value={executorInstances} onChange={(e) => setExecutorInstances(e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label>Glue WorkerType (informational)</label>
            <input type="text" placeholder="e.g. G.1X" value={glueWorkerType} onChange={(e) => setGlueWorkerType(e.target.value)} />
          </div>
          <div>
            <label>Glue NumberOfWorkers (informational)</label>
            <input type="text" placeholder="e.g. 4" value={glueNumberOfWorkers} onChange={(e) => setGlueNumberOfWorkers(e.target.value)} />
          </div>
        </div>
      </div>

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
