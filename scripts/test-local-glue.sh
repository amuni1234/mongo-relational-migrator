#!/usr/bin/env bash
set -euo pipefail

# Regenerates the AWS Glue job from the live schema/mapping and runs it for
# real -- using AWS's own Glue 4.0 Spark runtime container
# (amazon/aws-glue-libs) -- against the seeded Postgres + Mongo containers.
# No AWS account, no cost. Requires the backend running on BACKEND_URL and
# Docker Desktop with the migrator-e2e-pg / migrator-e2e-mongo containers up.

BACKEND_URL="${BACKEND_URL:-http://localhost:4000}"

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-test}"
PG_DATABASE="${PG_DATABASE:-postgres}"

# Reachable from inside the Glue container back to the host's published
# ports (Docker Desktop for Mac/Windows resolves this by default; the
# --add-host flag below makes it work on Linux too).
DOCKER_HOST_ALIAS="host.docker.internal"

MONGO_URI="${MONGO_URI:-mongodb://${DOCKER_HOST_ALIAS}:27017}"
MONGO_DATABASE="${MONGO_DATABASE:-migrator_test}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$(dirname "$SCRIPT_DIR")/.local-test"
mkdir -p "$OUT_DIR"

echo "==> Introspecting schema from Postgres (${PG_HOST}:${PG_PORT}/${PG_DATABASE})"
SCHEMA=$(curl -sf "${BACKEND_URL}/api/introspect" -H 'content-type: application/json' -d "{
  \"dbType\":\"postgres\",
  \"connection\":{\"host\":\"${PG_HOST}\",\"port\":${PG_PORT},\"user\":\"${PG_USER}\",\"password\":\"${PG_PASSWORD}\",\"database\":\"${PG_DATABASE}\"}
}")
echo "$SCHEMA" > "$OUT_DIR/schema.json"

echo "==> Suggesting embed/reference mapping"
MAPPING=$(curl -sf "${BACKEND_URL}/api/suggest-mapping" -H 'content-type: application/json' -d "{\"schema\": $SCHEMA}")
echo "$MAPPING" > "$OUT_DIR/mapping.json"

echo "==> Generating the Glue PySpark script"
curl -sf "${BACKEND_URL}/api/generate-glue-job" -H 'content-type: application/json' -d "{
  \"jdbc\": {\"url\": \"jdbc:postgresql://${DOCKER_HOST_ALIAS}:${PG_PORT}/${PG_DATABASE}\", \"user\": \"${PG_USER}\", \"driver\": \"org.postgresql.Driver\", \"passwordSecretName\": \"local-test-secret\"},
  \"mongo\": {\"uri\": \"${MONGO_URI}\", \"database\": \"${MONGO_DATABASE}\"},
  \"schema\": $SCHEMA,
  \"mapping\": $MAPPING
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['script'])" > "$OUT_DIR/glue_job.py"

echo "==> Swapping Secrets Manager for a local env var (test-only; real generator output is untouched)"
python3 "$SCRIPT_DIR/make_local_test_variant.py" "$OUT_DIR/glue_job.py" "$OUT_DIR/glue_job_local_test.py"

echo "==> Running the script in AWS's own Glue 4.0 container (no AWS account needed)"
docker run --rm \
  --add-host="${DOCKER_HOST_ALIAS}:host-gateway" \
  -v "$OUT_DIR/glue_job_local_test.py:/tmp/glue_job_local_test.py" \
  -e JDBC_PASSWORD="${PG_PASSWORD}" \
  -e AWS_REGION=us-east-1 \
  -e AWS_DEFAULT_REGION=us-east-1 \
  --entrypoint bash \
  amazon/aws-glue-libs:glue_libs_4.0.0_image_01 \
  -lc "spark-submit /tmp/glue_job_local_test.py --JOB_NAME local_test" \
  2>&1 | tee "$OUT_DIR/spark_run.log" | tail -30

echo ""
echo "Done. Full Spark log: $OUT_DIR/spark_run.log"
echo "Generated script:     $OUT_DIR/glue_job.py"