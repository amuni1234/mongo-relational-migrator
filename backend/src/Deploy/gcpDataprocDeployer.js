/**
 * NOT YET IMPLEMENTED.
 *
 * Deploying to GCP Dataproc needs its own path: uploading the script to
 * GCS, submitting a PySpark job via the Dataproc Jobs API (or a serverless
 * Dataproc batch), a service account with the right IAM roles, and
 * translating the Secrets-Manager password lookup in the generated script
 * to Secret Manager on GCP instead. That's a distinct, non-trivial chunk
 * of work rather than a copy-paste of the AWS path, so this is left as an
 * honest stub -- called out on the roadmap -- rather than faked.
 */

async function deployToGcpDataproc() {
  const err = new Error(
    "GCP Dataproc deployment is on the roadmap but not implemented yet. " +
      "AWS Glue deployment is available today."
  );
  err.status = 501;
  throw err;
}

module.exports = { deployToGcpDataproc };
