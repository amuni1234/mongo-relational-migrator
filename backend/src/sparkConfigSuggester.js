/**
 * Plain, clearly-labeled starting points for Spark/Glue sizing -- not a
 * scientific sizing model, just a sensible default to adjust from. Bracketed
 * on total on-disk size across the tables actually being migrated.
 *
 * The four Spark-config fields (driverMemory/executorMemory/executorCores/
 * executorInstances) are real spark-submit flags, equally applicable to a
 * local run of any of the three engines (Glue, EMR Serverless, EMR on EKS)
 * since all three fundamentally run via spark-submit.
 *
 * glueWorkerType/glueNumberOfWorkers are informational only -- a real AWS
 * Glue job sizes itself via job-level settings (Console/API), not anything
 * set inside the script, so these are surfaced as a suggestion to configure
 * externally, never applied to anything this tool runs itself.
 */

const GB = 1024 * 1024 * 1024;

const BRACKETS = [
  {
    bracket: "small",
    maxBytes: 1 * GB,
    driverMemory: "1g",
    executorMemory: "1g",
    executorCores: "1",
    executorInstances: "1",
    glueWorkerType: "G.1X",
    glueNumberOfWorkers: 2,
  },
  {
    bracket: "medium",
    maxBytes: 10 * GB,
    driverMemory: "2g",
    executorMemory: "4g",
    executorCores: "2",
    executorInstances: "2",
    glueWorkerType: "G.1X",
    glueNumberOfWorkers: 4,
  },
  {
    bracket: "large",
    maxBytes: Infinity,
    driverMemory: "4g",
    executorMemory: "8g",
    executorCores: "4",
    executorInstances: "4",
    glueWorkerType: "G.2X",
    glueNumberOfWorkers: 4,
  },
];

function suggestSparkConfig(totalSizeBytes) {
  const match = BRACKETS.find((b) => totalSizeBytes <= b.maxBytes);
  const { maxBytes, ...suggestion } = match;
  return suggestion;
}

module.exports = { suggestSparkConfig };
