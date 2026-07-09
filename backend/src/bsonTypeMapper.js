/**
 * Maps source SQL types (Postgres/MySQL `information_schema.data_type`
 * strings) to a target MongoDB/BSON type, and from there to the Spark SQL
 * type string used to `.cast(...)` a column in the generated Glue job.
 *
 * Kept as a small fixed set rather than the full BSON type list, matching
 * what's actually distinguishable from a source SQL type: string, int,
 * long, double, decimal128, bool, date.
 */

const BSON_TYPES = ["string", "int", "long", "double", "decimal128", "bool", "date"];

const TYPE_MAP = {
  // integers
  integer: "int",
  int: "int",
  smallint: "int",
  tinyint: "int",
  mediumint: "int",
  bigint: "long",
  // floating point / arbitrary precision
  numeric: "decimal128",
  decimal: "decimal128",
  real: "double",
  float: "double",
  "double precision": "double",
  double: "double",
  // text
  "character varying": "string",
  varchar: "string",
  character: "string",
  char: "string",
  text: "string",
  tinytext: "string",
  mediumtext: "string",
  longtext: "string",
  // boolean
  boolean: "bool",
  bool: "bool",
  // date/time -- BSON's Date is a full instant, so every source
  // date/time-ish type maps here (see bsonTypeToSparkType for why this
  // casts to Spark's "timestamp", not "date")
  "timestamp without time zone": "date",
  "timestamp with time zone": "date",
  timestamp: "date",
  datetime: "date",
  date: "date",
};

/**
 * Returns { bsonType, confident }. `confident: false` means `sourceDataType`
 * wasn't recognized and the "string" fallback was used -- the caller/UI
 * should surface that distinction rather than silently presenting a guess
 * as if it were a confirmed mapping.
 */
function inferDefaultBsonType(sourceDataType) {
  const normalized = String(sourceDataType || "").toLowerCase().trim();
  const bsonType = TYPE_MAP[normalized];
  if (bsonType) return { bsonType, confident: true };
  return { bsonType: "string", confident: false };
}

const SPARK_TYPE_MAP = {
  string: "string",
  int: "int",
  long: "bigint",
  double: "double",
  // Source column precision/scale isn't captured by introspect.js today, so
  // this is a fixed generous size rather than one derived from the source.
  decimal128: "decimal(38,10)",
  bool: "boolean",
  // NOT "date" -- BSON's Date type is a full instant (like Postgres's
  // `timestamp without time zone`); Spark's DateType would drop the time
  // component and silently truncate every datetime column cast this way.
  date: "timestamp",
};

function bsonTypeToSparkType(bsonType) {
  return SPARK_TYPE_MAP[bsonType] || SPARK_TYPE_MAP.string;
}

module.exports = { BSON_TYPES, inferDefaultBsonType, bsonTypeToSparkType };
