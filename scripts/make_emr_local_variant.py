#!/usr/bin/env python3
"""
Second pass on make_local_test_variant.py's output: swaps the Glue-specific
scaffold (awsglue imports, GlueContext, Job) for a plain PySpark SparkSession,
and drops the trailing job.commit() -- for running the exact same
transformation logic inside a plain-Spark image (e.g. an EMR Serverless base
image) that has no awsglue package at all. Only used for local test runs --
the real generator output (glueJobGenerator.js) is untouched.

The `from pyspark.sql.functions import ...` line's contents vary per script
(depends on load mode/watermarks/computed columns), so this can't be one
fixed exact-string swap like the Secrets Manager block -- it anchors on the
two lines that are always present verbatim (the scaffold's first and last
line) and regex-extracts the dynamic import list from between them.
"""
import re
import sys

SCAFFOLD_PATTERN = re.compile(
    r"import sys\n"
    r"from awsglue\.transforms import \*\n"
    r"from awsglue\.utils import getResolvedOptions\n"
    r"from pyspark\.context import SparkContext\n"
    r"from awsglue\.context import GlueContext\n"
    r"from awsglue\.job import Job\n"
    r"from pyspark\.sql\.functions import (.+)\n"
    r"\n"
    r"args = getResolvedOptions\(sys\.argv, \[\"JOB_NAME\"\]\)\n"
    r"sc = SparkContext\(\)\n"
    r"glueContext = GlueContext\(sc\)\n"
    r"spark = glueContext\.spark_session\n"
    r"job = Job\(glueContext\)\n"
    r"job\.init\(args\[\"JOB_NAME\"\], args\)\n"
)

FOOTER_PATTERN = re.compile(r"\n*job\.commit\(\)\n*$")


def main():
    src_path, dst_path = sys.argv[1], sys.argv[2]
    with open(src_path) as f:
        content = f.read()

    match = SCAFFOLD_PATTERN.search(content)
    if not match:
        sys.exit(
            "Glue scaffold not found -- glueJobGenerator.js's template may "
            "have changed; update SCAFFOLD_PATTERN in this script to match."
        )
    pyspark_functions_import = match.group(1)
    replacement = (
        "from pyspark.sql import SparkSession\n"
        f"from pyspark.sql.functions import {pyspark_functions_import}\n"
        "\n"
        "# This base image defaults to a real EMR Serverless cluster manager\n"
        '# (expects actual AWS endpoints) -- force local[*] so it runs\n'
        "# standalone instead, same as any other local Spark test.\n"
        'spark = SparkSession.builder.appName("relational_to_mongo_migration").master("local[*]").getOrCreate()\n'
    )
    content = SCAFFOLD_PATTERN.sub(replacement, content, count=1)

    if not FOOTER_PATTERN.search(content):
        sys.exit(
            "Trailing job.commit() not found -- glueJobGenerator.js's "
            "template may have changed; update FOOTER_PATTERN in this "
            "script to match."
        )
    content = FOOTER_PATTERN.sub("\n", content)

    with open(dst_path, "w") as f:
        f.write(content)


if __name__ == "__main__":
    main()
