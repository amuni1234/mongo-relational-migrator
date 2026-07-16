/**
 * Deploys a generated Glue script for real: uploads it to S3, then
 * creates (or updates, if it already exists) an AWS Glue job pointing at
 * that script, and starts a job run.
 *
 * This makes real AWS API calls -- it needs valid AWS credentials in the
 * backend's environment (the usual SDK credential chain: env vars,
 * ~/.aws/credentials, an EC2/ECS instance role, etc.) and an IAM role ARN
 * that Glue is allowed to assume (`roleArn`), with permissions for Glue,
 * S3 (read the script), Secrets Manager (read the JDBC password), and
 * whatever JDBC connection Glue needs network access to.
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  GlueClient,
  GetJobCommand,
  CreateJobCommand,
  UpdateJobCommand,
  StartJobRunCommand,
} = require("@aws-sdk/client-glue");

async function deployToAwsGlue({
  region,
  s3Bucket,
  s3Key,
  script,
  jobName,
  roleArn,
  glueVersion = "4.0",
  workerType = "G.1X",
  numberOfWorkers = 2,
  extraJarsS3Path, // e.g. s3://bucket/jars/mongo-spark-connector-assembly.jar
}) {
  if (!region) throw new Error("region is required");
  if (!s3Bucket || !s3Key) throw new Error("s3Bucket and s3Key are required");
  if (!script) throw new Error("script is required");
  if (!jobName) throw new Error("jobName is required");
  if (!roleArn) throw new Error("roleArn is required (the IAM role Glue will assume)");

  const s3 = new S3Client({ region });
  const glue = new GlueClient({ region });

  await s3.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      Body: script,
      ContentType: "text/x-python",
    })
  );
  const scriptLocation = `s3://${s3Bucket}/${s3Key}`;

  const jobDefinition = {
    Name: jobName,
    Role: roleArn,
    GlueVersion: glueVersion,
    Command: {
      Name: "glueetl",
      ScriptLocation: scriptLocation,
      PythonVersion: "3",
    },
    DefaultArguments: {
      "--job-language": "python",
      ...(extraJarsS3Path ? { "--extra-jars": extraJarsS3Path } : {}),
    },
    WorkerType: workerType,
    NumberOfWorkers: numberOfWorkers,
  };

  let existed = true;
  try {
    await glue.send(new GetJobCommand({ JobName: jobName }));
  } catch (err) {
    if (err.name === "EntityNotFoundException") {
      existed = false;
    } else {
      throw err;
    }
  }

  if (existed) {
    await glue.send(new UpdateJobCommand({ JobName: jobName, JobUpdate: jobDefinition }));
  } else {
    await glue.send(new CreateJobCommand(jobDefinition));
  }

  const runResult = await glue.send(new StartJobRunCommand({ JobName: jobName }));

  return {
    target: "aws-glue",
    jobName,
    scriptLocation,
    action: existed ? "updated" : "created",
    jobRunId: runResult.JobRunId,
    consoleUrl: `https://${region}.console.aws.amazon.com/gluestudio/home?region=${region}#/job/${encodeURIComponent(
      jobName
    )}/runs`,
  };
}

module.exports = { deployToAwsGlue };
