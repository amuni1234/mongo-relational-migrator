/**
 * Real dry-run validation for a computed column's expression: reads exactly
 * one row from the user's actual source table via JDBC and tries to
 * evaluate the expression against it with a real (throwaway) Spark session,
 * inside the same Docker Glue image already used for every other local
 * verification in this project (`scripts/test-local-glue.sh`). This is
 * strictly a "warn, don't block" signal for the UI -- the caller decides
 * whether to add the column anyway on failure.
 *
 * Unlike the real generated Glue job, this always targets local Docker
 * execution, so `connection.host` values of "localhost"/"127.0.0.1" are
 * rewritten to "host.docker.internal" automatically -- there's no
 * equivalent rewrite in glueJobGenerator.js because that script's JDBC host
 * is whatever the user configures for wherever it will actually run.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { bsonTypeToSparkType } = require("./bsonTypeMapper");
const { pythonStr, pythonExprStr } = require("./generators/glueJobGenerator");

// Keep in sync with frontend/src/components/GlueJobPreview.jsx's
// DRIVER_BY_TYPE -- duplicated rather than imported since frontend/backend
// are separate bundles.
const DRIVER_BY_TYPE = {
  postgres: "org.postgresql.Driver",
  mysql: "com.mysql.cj.jdbc.Driver",
};

function dockerHost(host) {
  return host === "localhost" || host === "127.0.0.1" ? "host.docker.internal" : host;
}

function buildJdbcUrl(dbType, connection) {
  const host = dockerHost(connection.host);
  const scheme = dbType === "postgres" ? "jdbc:postgresql" : "jdbc:mysql";
  return `${scheme}://${host}:${connection.port}/${connection.database}`;
}

function buildValidationScript({ dbType, connection, table, expression, bsonType }) {
  const sparkType = bsonTypeToSparkType(bsonType || "string");
  const jdbcUrl = buildJdbcUrl(dbType, connection);
  const driver = DRIVER_BY_TYPE[dbType];
  return `
from pyspark.sql import SparkSession
from pyspark.sql.functions import expr

spark = SparkSession.builder.appName("validate_computed_expression").getOrCreate()

try:
    df = (
        spark.read.format("jdbc")
        .option("url", ${pythonStr(jdbcUrl)})
        .option("dbtable", ${pythonStr(table)})
        .option("user", ${pythonStr(connection.user)})
        .option("password", ${pythonStr(connection.password)})
        .option("driver", ${pythonStr(driver)})
        .load()
        .limit(1)
    )
    df.select(expr(${pythonExprStr(expression)}).cast(${pythonStr(sparkType)}).alias("_validation_result")).collect()
    print("VALIDATION_OK")
except Exception as e:
    print(f"VALIDATION_ERROR: {e}")
`;
}

function runValidation(scriptText) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `validate-computed-expr-${crypto.randomUUID()}.py`);
    fs.writeFileSync(tmpFile, scriptText);

    execFile(
      "docker",
      [
        "run",
        "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-v",
        `${tmpFile}:/tmp/validate.py`,
        "--entrypoint",
        "bash",
        "amazon/aws-glue-libs:glue_libs_4.0.0_image_01",
        "-lc",
        "spark-submit /tmp/validate.py",
      ],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        fs.unlink(tmpFile, () => {});
        const output = `${stdout}\n${stderr}`;
        const errorMatch = output.match(/VALIDATION_ERROR: ([\s\S]*)/);
        if (output.includes("VALIDATION_OK")) {
          resolve({ valid: true });
        } else if (errorMatch) {
          // First line is almost always the actual exception message;
          // the rest is a Py4J/JVM traceback tail not worth surfacing.
          resolve({ valid: false, error: errorMatch[1].trim().split("\n")[0] });
        } else {
          // Neither marker printed -- the script never got as far as its
          // own try/except (Docker missing, image pull failure, timeout,
          // JVM crash). This is an infra failure, not an expression
          // problem -- reject so the route's catch turns it into a 500,
          // letting the frontend tell the two cases apart.
          reject(err || new Error("Validation script produced no result (Docker or the database may be unreachable)"));
        }
      }
    );
  });
}

async function validateComputedExpression({ dbType, connection, table, expression, bsonType }) {
  const script = buildValidationScript({ dbType, connection, table, expression, bsonType });
  return runValidation(script);
}

module.exports = { validateComputedExpression };
