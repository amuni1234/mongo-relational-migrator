/**
 * Generates a PySpark script written for AWS Glue that:
 *   1. Reads each source table via JDBC (Glue's native JDBC connection)
 *   2. For each target collection, joins in "embed" child tables and
 *      collapses them into a nested array field via collect_list(struct(...))
 *   3. Leaves "reference" child tables as their own collections, writing
 *      only the foreign key (no embedding) so they can be looked up
 *      independently at read time
 *   4. Writes each resulting DataFrame to MongoDB using the MongoDB
 *      Spark Connector
 *
 * The generated script is meant to be uploaded as a Glue job script
 * (Glue 4.0+, Spark 3.x) with the MongoDB Spark Connector added as a
 * job dependency (--extra-jars or the connector's Maven coordinates via
 * --additional-python-modules / connector marketplace connection).
 */

const { bsonTypeToSparkType } = require("../bsonTypeMapper");

function pythonStr(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

// Casts every column of a just-read table to its (possibly user-overridden)
// target BSON type's Spark equivalent, re-aliasing to the same column name
// so nothing downstream (struct field lists, join-key references) needs to
// change. Applied unconditionally to every column on every table read --
// root, embed children, and reference tables -- rather than only when a
// user diverges from the inferred default, so two logically-identical
// columns in different tables don't end up cast vs. not depending on
// whether someone happened to touch a dropdown.
function castSelectLines(varName, table) {
  const castExprs = table.columns.map((c) => {
    const sparkType = bsonTypeToSparkType(c.bsonType);
    return `col(${pythonStr(c.name)}).cast(${pythonStr(sparkType)}).alias(${pythonStr(c.name)})`;
  });
  return `${varName} = ${varName}.select(\n    ${castExprs.join(",\n    ")}\n)`;
}

// SCD2 needs a few extra pyspark functions the other two modes don't --
// only pulled in when SCD2 is actually selected, so Full/Incremental
// scripts don't carry unused imports.
const PYSPARK_FUNCTIONS_BY_MODE = {
  full: "collect_list, struct, col",
  incremental: "collect_list, struct, col",
  scd2: "collect_list, struct, col, sha2, concat_ws, current_timestamp, lit, array_sort, expr",
};

// Appended to write_to_mongo's body only when SCD2 is selected -- compares
// each incoming row's content hash against the collection's current
// (isCurrent=true) documents: unchanged rows are dropped, changed/new rows
// close out their prior version (a partial update, not a replace, so the
// old document's content is preserved untouched as history) and get a
// fresh current version inserted.
const WRITE_SCD2_FUNCTION = `

def _write_scd2(new_df, collection_name, business_key_cols):
    content_cols = new_df.columns
    new_df = new_df.withColumn(
        "_contentHash", sha2(concat_ws("||", *[col(c).cast("string") for c in content_cols]), 256)
    )

    current_df = (
        spark.read.format("mongodb")
        .option("connection.uri", MONGO_URI)
        .option("database", MONGO_DATABASE)
        .option("collection", collection_name)
        .load()
    )
    current_live = (
        current_df.filter(col("isCurrent") == True)
        if "isCurrent" in current_df.columns
        else current_df.limit(0)
    )

    if current_live.rdd.isEmpty():
        to_insert = (
            new_df.withColumn("_versionId", expr("uuid()"))
            .withColumn("isCurrent", lit(True))
            .withColumn("validFrom", current_timestamp())
            .withColumn("validTo", lit(None).cast("timestamp"))
        )
        (
            to_insert.write.format("mongodb")
            .mode("append")
            .option("connection.uri", MONGO_URI)
            .option("database", MONGO_DATABASE)
            .option("collection", collection_name)
            .save()
        )
        return

    # Match on our own plain-string _versionId, not MongoDB's own _id -- the
    # Spark Connector reads an ObjectId _id back as a bare hex string with
    # no type marker, and writing that same string back doesn't get
    # reinterpreted as the original ObjectId, so idFieldList="_id" would
    # silently insert a brand new document instead of matching the existing
    # one. A field we generate and control end-to-end (uuid(), a plain
    # string both ways) avoids that round-trip problem entirely.
    joined = new_df.join(
        current_live.select(
            *business_key_cols,
            col("_contentHash").alias("_oldHash"),
            col("_versionId").alias("_oldVersionId"),
        ),
        on=business_key_cols,
        how="left",
    )
    changed_or_new = joined.filter(col("_oldHash").isNull() | (col("_oldHash") != col("_contentHash")))

    to_close = changed_or_new.filter(col("_oldVersionId").isNotNull()).select(
        col("_oldVersionId").alias("_versionId"),
        lit(False).alias("isCurrent"),
        current_timestamp().alias("validTo"),
    )
    if not to_close.rdd.isEmpty():
        (
            to_close.write.format("mongodb")
            .mode("append")
            .option("operationType", "update")
            .option("idFieldList", "_versionId")
            .option("connection.uri", MONGO_URI)
            .option("database", MONGO_DATABASE)
            .option("collection", collection_name)
            .save()
        )

    to_insert = (
        changed_or_new.select(*new_df.columns)
        .withColumn("_versionId", expr("uuid()"))
        .withColumn("isCurrent", lit(True))
        .withColumn("validFrom", current_timestamp())
        .withColumn("validTo", lit(None).cast("timestamp"))
    )
    (
        to_insert.write.format("mongodb")
        .mode("append")
        .option("connection.uri", MONGO_URI)
        .option("database", MONGO_DATABASE)
        .option("collection", collection_name)
        .save()
    )
`;

function generateGlueJob({ jdbc, mongo, schema, mapping, loadMode = "full" }) {
  const tableByName = new Map(schema.tables.map((t) => [t.name, t]));

  const header = `"""
Auto-generated AWS Glue ETL job.
Source: JDBC relational database  ->  Target: MongoDB

Generated by: MongoDB Relational Migrator (Node/React tool)
Do not edit column/table names below without re-running the generator --
they are derived directly from the source schema + mapping you designed.

Load mode: ${loadMode}
${
  loadMode === "incremental"
    ? "Incremental: upserts by primary key (idempotent re-runs -- inserts new\n" +
      "rows, updates changed ones) but does NOT delete target documents whose\n" +
      "source row was deleted, and does NOT reduce how much is read from the\n" +
      "source -- every run still reads the full table via JDBC."
    : loadMode === "scd2"
    ? "Incremental (SCD2): preserves history instead of replacing in place --\n" +
      "an unchanged row is left alone, a changed or new row gets a fresh\n" +
      "current version inserted while its prior version is marked no-longer-\n" +
      "current (isCurrent=false, validTo=<now>) rather than overwritten. Like\n" +
      "Incremental, this still reads the full table via JDBC every run -- the\n" +
      "efficiency gain here is fewer/no-op MongoDB writes when nothing changed,\n" +
      "not less reading from the source."
    : "Full: drops/truncates each target collection before writing (the MongoDB\nSpark Connector's default behavior for mode(\"overwrite\"))."
}
"""

import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql.functions import ${PYSPARK_FUNCTIONS_BY_MODE[loadMode] || PYSPARK_FUNCTIONS_BY_MODE.full}

args = getResolvedOptions(sys.argv, ["JOB_NAME"])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args["JOB_NAME"], args)

# ---------------------------------------------------------------------------
# Connection settings
# ---------------------------------------------------------------------------
JDBC_URL = ${pythonStr(jdbc.url)}
JDBC_USER = ${pythonStr(jdbc.user)}
JDBC_PASSWORD_SECRET_NAME = ${pythonStr(jdbc.passwordSecretName || "REPLACE_WITH_SECRETS_MANAGER_NAME")}
JDBC_DRIVER = ${pythonStr(jdbc.driver)}

MONGO_URI = ${pythonStr(mongo.uri)}
MONGO_DATABASE = ${pythonStr(mongo.database)}

# "full" drops/truncates each target collection before writing; "incremental"
# upserts by primary key instead; "scd2" preserves history (see docstring
# above for the full tradeoffs of each).
LOAD_MODE = ${pythonStr(loadMode)}

# Resolve the JDBC password from AWS Secrets Manager at runtime rather than
# hardcoding it in the script.
import boto3, json as _json
_secrets = boto3.client("secretsmanager")
_secret_value = _secrets.get_secret_value(SecretId=JDBC_PASSWORD_SECRET_NAME)
JDBC_PASSWORD = _json.loads(_secret_value["SecretString"]).get("password")


def read_table(table_name):
    return (
        spark.read.format("jdbc")
        .option("url", JDBC_URL)
        .option("dbtable", table_name)
        .option("user", JDBC_USER)
        .option("password", JDBC_PASSWORD)
        .option("driver", JDBC_DRIVER)
        .load()
    )


def write_to_mongo(df, collection_name, id_field_list=None):
    if LOAD_MODE == "scd2" and id_field_list:
        _write_scd2(df, collection_name, id_field_list.split(","))
        return
    writer = df.write.format("mongodb")
    if LOAD_MODE == "incremental" and id_field_list:
        # Upsert: replace a document matching id_field_list's value, insert
        # if no match exists (operationType="replace"/upsertDocument=true
        # are the MongoDB Spark Connector's own defaults -- not set here).
        writer = writer.mode("append").option("idFieldList", id_field_list)
    else:
        writer = writer.mode("overwrite")
    (
        writer
        .option("connection.uri", MONGO_URI)
        .option("database", MONGO_DATABASE)
        .option("collection", collection_name)
        .save()
    )
${loadMode === "scd2" ? WRITE_SCD2_FUNCTION : ""}
`;

  const collectionBlocks = mapping.collections
    .map((collection) => generateCollectionBlock(collection, tableByName, loadMode))
    .join("\n\n");

  const footer = `

job.commit()
`;

  return header + collectionBlocks + footer;
}

function generateCollectionBlock(collection, tableByName, loadMode) {
  const rootVar = toVar(collection.rootTable);
  const rootTable = tableByName.get(collection.rootTable);
  const lines = [];

  lines.push(`# ---------------------------------------------------------------------------`);
  lines.push(`# Collection: ${collection.collectionName}  (root table: ${collection.rootTable})`);
  lines.push(`# ---------------------------------------------------------------------------`);
  lines.push(`${rootVar} = read_table(${pythonStr(collection.rootTable)})`);
  if (rootTable) lines.push(castSelectLines(rootVar, rootTable));

  let currentVar = rootVar;

  // Embeds: read child table, group by FK, collect_list(struct(...)) the
  // non-key columns, then left-join that nested array back onto the root.
  // embed.foreignKey is always an array (length 1 for an ordinary FK,
  // length N for a composite one) -- join keys are aliased positionally
  // (_join_key_0, _join_key_1, ...) and the root join ANDs every position,
  // pairing collection.primaryKey[i] with _join_key_i.
  for (const embed of collection.embeds) {
    const childTable = tableByName.get(embed.table);
    if (!childTable) continue;

    const childVar = toVar(embed.table);
    const nestedVar = `${childVar}_nested`;
    const fkCols = embed.foreignKey;
    const childPk = childTable.primaryKey && childTable.primaryKey[0];
    // Primary key first, everything else keeping its original relative
    // order -- lets plain array_sort(...) (single-argument; Spark 3.3/Glue
    // 4.0 doesn't support the 2-argument custom-comparator form added in
    // Spark 3.4) sort structs by their first field and get "sorted by PK"
    // for free, with no comparator needed.
    const nonKeyCols = childTable.columns
      .filter((c) => !fkCols.includes(c.name))
      .map((c) => c.name)
      .sort((a, b) => (a === childPk ? -1 : b === childPk ? 1 : 0));

    const structFields = nonKeyCols
      .map((c) => `col(${pythonStr(c)}).alias(${pythonStr(c)})`)
      .join(", ");

    const joinKeyAliases = fkCols.map((_, i) => `_join_key_${i}`);
    const joinKeySelectExprs = fkCols
      .map((c, i) => `col(${pythonStr(c)}).alias(${pythonStr(joinKeyAliases[i])})`)
      .join(", ");

    lines.push("");
    lines.push(`# Embed "${embed.table}" as "${embed.as}" (${embed.cardinality})`);
    lines.push(`${childVar} = read_table(${pythonStr(embed.table)})`);
    lines.push(castSelectLines(childVar, childTable));

    if (embed.cardinality === "one") {
      // 1:1 or 1:few-but-flattened -> embed as a single nested object per row.
      lines.push(
        `${nestedVar} = ${childVar}.select(${joinKeySelectExprs}, struct(${structFields}).alias(${pythonStr(embed.as)}))`
      );
    } else {
      // 1:many -> embed as an array of nested objects per row. In SCD2 mode,
      // collect_list's element order isn't stable across runs (Spark's
      // shuffle can reorder identical data differently run to run), which
      // would make the content hash spuriously differ even when nothing
      // changed -- wrap in array_sort (structs sort by their first field,
      // which nonKeyCols above guarantees is the child's own primary key)
      // so identical data always serializes/hashes identically. Not needed
      // for Full/Incremental, which don't compare content.
      const collectExpr = `collect_list(struct(${structFields}))`;
      const orderedCollectExpr =
        loadMode === "scd2" && childPk && nonKeyCols.includes(childPk)
          ? `array_sort(${collectExpr})`
          : collectExpr;
      lines.push(
        `${nestedVar} = ${childVar}.groupBy(${joinKeySelectExprs}).agg(${orderedCollectExpr}.alias(${pythonStr(embed.as)}))`
      );
    }

    const joinedVar = `${currentVar}_with_${childVar}`;
    const rootKeys = rootKeyCols(collection);
    const pairCount = Math.min(rootKeys.length, fkCols.length);
    const joinCond = Array.from(
      { length: pairCount },
      (_, i) => `(${currentVar}[${pythonStr(rootKeys[i])}] == ${nestedVar}[${pythonStr(joinKeyAliases[i])}])`
    ).join(" & ");
    const dropArgs = joinKeyAliases.map((a) => pythonStr(a)).join(", ");
    lines.push(
      `${joinedVar} = ${currentVar}.join(${nestedVar}, ${joinCond}, "left").drop(${dropArgs})`
    );
    currentVar = joinedVar;
  }

  lines.push("");
  lines.push(
    `write_to_mongo(${currentVar}, ${pythonStr(collection.collectionName)}, id_field_list=${pythonStr(idFieldListOf(collection.primaryKey))})`
  );

  // References: written to their own collection, keeping only the FK
  // (no embedding) so they can be looked up independently at read time.
  for (const ref of collection.references) {
    const refTable = tableByName.get(ref.table);
    if (!refTable) continue;

    const refVar = toVar(ref.table);
    lines.push("");
    lines.push(`# Reference "${ref.table}" -> kept as its own collection, linked by "${ref.foreignKey.join(", ")}"`);
    lines.push(`${refVar} = read_table(${pythonStr(ref.table)})`);
    lines.push(castSelectLines(refVar, refTable));
    lines.push(
      `write_to_mongo(${refVar}, ${pythonStr(pluralizeForVar(ref.table))}, id_field_list=${pythonStr(idFieldListOf(refTable.primaryKey))})`
    );
  }

  return lines.join("\n");
}

function rootKeyCols(collection) {
  return collection.primaryKey && collection.primaryKey.length ? collection.primaryKey : ["id"];
}

// Comma-joined primary key column(s) for the MongoDB Spark Connector's
// idFieldList write option, used only in incremental (upsert) load mode.
function idFieldListOf(primaryKey) {
  return primaryKey && primaryKey.length ? primaryKey.join(",") : "id";
}

function toVar(tableName) {
  return `df_${tableName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function pluralizeForVar(name) {
  if (name.endsWith("s")) return name;
  return `${name}s`;
}

module.exports = { generateGlueJob };
