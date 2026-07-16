import { useState } from "react";
import { api } from "../api";

/**
 * Deploys the generated script for real. AWS Glue is fully wired up (needs
 * real AWS credentials in the backend's environment + an IAM role ARN).
 * GCP Dataproc is intentionally left as a "coming soon" option rather than
 * faked — see backend/src/deploy/gcpDataprocDeployer.js for why.
 */
export default function DeployPanel({ script }) {
  const [target, setTarget] = useState("aws-glue");
  const [region, setRegion] = useState("us-east-1");
  const [jobName, setJobName] = useState("relational-to-mongo-migration");
  const [roleArn, setRoleArn] = useState("");
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3Key, setS3Key] = useState("glue-scripts/relational-to-mongo-migration.py");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function deploy() {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await api.deployJob({
        target,
        region,
        jobName,
        roleArn,
        s3Bucket,
        s3Key,
        script,
      });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!script) {
    return (
      <div className="panel">
        <h2>6. Deploy the job</h2>
        <p className="hint">Generate the Glue script in the previous step first.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>6. Deploy the job</h2>
      <p className="hint">
        Uploads the generated script to S3, creates (or updates) the Glue
        job, and starts a run. Requires real AWS credentials configured in
        the backend's environment and an IAM role Glue can assume.
      </p>

      <label>Target</label>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="aws-glue">AWS Glue</option>
        <option value="gcp-dataproc">GCP Dataproc (coming soon)</option>
      </select>

      {target === "gcp-dataproc" && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          GCP Dataproc deployment isn't implemented yet — it's on the
          roadmap. Choose AWS Glue to deploy today.
        </div>
      )}

      {target === "aws-glue" && (
        <>
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div>
              <label>AWS region</label>
              <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} />
            </div>
            <div>
              <label>Glue job name</label>
              <input type="text" value={jobName} onChange={(e) => setJobName(e.target.value)} />
            </div>
          </div>
          <label>IAM role ARN (that Glue will assume)</label>
          <input
            type="text"
            value={roleArn}
            onChange={(e) => setRoleArn(e.target.value)}
            placeholder="arn:aws:iam::123456789012:role/GlueMigrationRole"
          />
          <div className="grid-2">
            <div>
              <label>S3 bucket (for the script)</label>
              <input type="text" value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} />
            </div>
            <div>
              <label>S3 key</label>
              <input type="text" value={s3Key} onChange={(e) => setS3Key(e.target.value)} />
            </div>
          </div>

          <button
            className="btn"
            onClick={deploy}
            disabled={loading || !roleArn || !s3Bucket}
            style={{ marginTop: 12 }}
          >
            {loading ? "Deploying…" : "Deploy & run on AWS Glue"}
          </button>
        </>
      )}

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {result && (
        <div className="status-line ok" style={{ marginTop: 16 }}>
          Job {result.action} and a run was started — job run ID{" "}
          <code>{result.jobRunId}</code>.{" "}
          <a href={result.consoleUrl} target="_blank" rel="noreferrer">
            View in the Glue console →
          </a>
        </div>
      )}
    </div>
  );
}