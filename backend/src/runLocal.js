/**
 * One-click local verification: takes the same { jdbc, mongo, schema,
 * mapping, loadMode } shape /api/generate-glue-job already accepts, plus
 * `dbType` (to pick the right JDBC driver Maven coordinate for the EMR
 * paths) and `engine` ("glue" | "emr-serverless" | "emr-eks"), and actually
 * *runs* the generated script -- productizing the exact manual local-Docker
 * workflow already proven throughout this project
 * (scripts/test-local-glue.sh): swap the Secrets Manager block for an env
 * var via make_local_test_variant.py, optionally swap the Glue scaffold for
 * plain PySpark via make_emr_local_variant.py (either EMR flavor needs
 * this -- neither image has the awsglue package), then docker run it
 * against the real local Postgres/Mongo containers.
 *
 * Never touches glueJobGenerator.js's real output -- both transform
 * scripts are local-testing-only post-processing, exactly like the
 * existing manual workflow. No cloud credentials, no billing -- this only
 * ever talks to Docker and whatever local database/Mongo the user already
 * has running.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { generateGlueJob } = require("./generators/glueJobGenerator");

const SCRIPTS_DIR = path.join(__dirname, "..", "..", "scripts");

const GLUE_IMAGE = "amazon/aws-glue-libs:glue_libs_4.0.0_image_01";
// Two distinct, official AWS EMR container families -- confirmed live,
// both real and pullable, both lacking the awsglue package and the JDBC/
// Mongo jars (needing --packages). They differ in how stubbornly they
// default away from local execution: Serverless only needs .master() set
// inside the script (handled by make_emr_local_variant.py); EKS's
// spark-submit defaults to a real Kubernetes master *and* cluster deploy
// mode at the CLI level, so forcing it local needs explicit
// --master/--deploy-mode flags on the spark-submit invocation itself.
const EMR_SERVERLESS_IMAGE = "public.ecr.aws/emr-serverless/spark/emr-7.0.0:latest";
const EMR_EKS_IMAGE = "public.ecr.aws/emr-on-eks/spark/emr-7.0.0:latest";

const MAVEN_JDBC_PACKAGE = {
  postgres: "org.postgresql:postgresql:42.7.3",
  mysql: "com.mysql:mysql-connector-j:8.3.0",
};
const MONGO_SPARK_MAVEN_PACKAGE = "org.mongodb.spark:mongo-spark-connector_2.12:10.4.0";

// This one-click run always targets the containers on the same machine as
// the backend -- rewrite localhost/127.0.0.1 to host.docker.internal so it
// works regardless of what the user typed into the Glue-job step's fields
// (which are otherwise left exactly as typed for the "download the real
// script" path). Same reasoning as validateComputedExpression.js's
// dockerHost(), applied to a full URL/URI string instead of a bare host.
function rewriteHostForDocker(urlOrUri) {
  return urlOrUri.replace(/localhost|127\.0\.0\.1/g, "host.docker.internal");
}

function runPythonScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile("python3", [scriptPath, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const log = `${stdout}\n${stderr}`;
        if (err) {
          // Docker itself missing/unreachable is an infra failure, not "the
          // job ran and failed" -- distinguish so the route can 500 instead
          // of reporting a bogus job failure.
          const infraFailure = err.code === "ENOENT" || /Cannot connect to the Docker daemon/.test(log);
          if (infraFailure) return reject(new Error(log.trim() || err.message));
          return resolve({ success: false, log });
        }
        resolve({ success: true, log });
      }
    );
  });
}

async function runLocal({ dbType, jdbc, mongo, schema, mapping, loadMode, engine }) {
  const localJdbc = { ...jdbc, url: rewriteHostForDocker(jdbc.url) };
  const localMongo = { ...mongo, uri: rewriteHostForDocker(mongo.uri) };
  const script = generateGlueJob({ jdbc: localJdbc, mongo: localMongo, schema, mapping, loadMode });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrator-run-"));
  try {
    const rawPath = path.join(workDir, "glue_job.py");
    const localTestPath = path.join(workDir, "glue_job_local_test.py");
    fs.writeFileSync(rawPath, script);
    await runPythonScript(path.join(SCRIPTS_DIR, "make_local_test_variant.py"), [rawPath, localTestPath]);

    const isEmr = engine === "emr-serverless" || engine === "emr-eks";
    let runPath = localTestPath;
    if (isEmr) {
      const emrPath = path.join(workDir, "glue_job_emr.py");
      await runPythonScript(path.join(SCRIPTS_DIR, "make_emr_local_variant.py"), [localTestPath, emrPath]);
      runPath = emrPath;
    }

    const containerScriptPath = "/tmp/glue_job_local_test.py";
    const jdbcPassword = jdbc.password || "";
    const jdbcMavenPackage = MAVEN_JDBC_PACKAGE[dbType] || MAVEN_JDBC_PACKAGE.postgres;

    let dockerArgs;
    if (engine === "emr-eks") {
      // Confirmed live: this image's spark-submit defaults to a real
      // Kubernetes master + cluster deploy mode -- both must be overridden
      // as spark-submit's own CLI flags, not just inside the script.
      dockerArgs = [
        "run", "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-v", `${runPath}:${containerScriptPath}`,
        "-e", `JDBC_PASSWORD=${jdbcPassword}`,
        "--entrypoint", "bash",
        EMR_EKS_IMAGE,
        "-lc",
        `spark-submit --master 'local[*]' --deploy-mode client --packages ${jdbcMavenPackage},${MONGO_SPARK_MAVEN_PACKAGE} ${containerScriptPath}`,
      ];
    } else if (engine === "emr-serverless") {
      dockerArgs = [
        "run", "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-v", `${runPath}:${containerScriptPath}`,
        "-e", `JDBC_PASSWORD=${jdbcPassword}`,
        "--entrypoint", "bash",
        EMR_SERVERLESS_IMAGE,
        "-lc",
        `spark-submit --packages ${jdbcMavenPackage},${MONGO_SPARK_MAVEN_PACKAGE} ${containerScriptPath}`,
      ];
    } else {
      dockerArgs = [
        "run", "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-v", `${runPath}:${containerScriptPath}`,
        "-e", `JDBC_PASSWORD=${jdbcPassword}`,
        "-e", "AWS_REGION=us-east-1",
        "-e", "AWS_DEFAULT_REGION=us-east-1",
        "--entrypoint", "bash",
        GLUE_IMAGE,
        "-lc", `spark-submit ${containerScriptPath} --JOB_NAME local_run`,
      ];
    }

    const result = await runDocker(dockerArgs);
    return { engine, ...result };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { runLocal };
