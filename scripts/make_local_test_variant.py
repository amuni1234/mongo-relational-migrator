#!/usr/bin/env python3
"""
Swaps the generated Glue script's AWS Secrets Manager lookup for a plain
JDBC_PASSWORD env var read, since the local aws-glue-libs container has no
AWS credentials to call Secrets Manager. Only used for local test runs --
the real generator output (glueJobGenerator.js) is untouched.
"""
import sys

SECRETS_MANAGER_BLOCK = '''# Resolve the JDBC password from AWS Secrets Manager at runtime rather than
# hardcoding it in the script.
import boto3, json as _json
_secrets = boto3.client("secretsmanager")
_secret_value = _secrets.get_secret_value(SecretId=JDBC_PASSWORD_SECRET_NAME)
JDBC_PASSWORD = _json.loads(_secret_value["SecretString"]).get("password")'''

LOCAL_TEST_BLOCK = '''# LOCAL TEST ONLY: the real generated script resolves this from AWS Secrets
# Manager (see JDBC_PASSWORD_SECRET_NAME above) -- swapped for an env var
# here since this container has no AWS credentials to call Secrets Manager.
import os
JDBC_PASSWORD = os.environ["JDBC_PASSWORD"]'''


def main():
    src_path, dst_path = sys.argv[1], sys.argv[2]
    with open(src_path) as f:
        content = f.read()

    if SECRETS_MANAGER_BLOCK not in content:
        sys.exit(
            "Secrets Manager block not found -- glueJobGenerator.js's template "
            "may have changed; update SECRETS_MANAGER_BLOCK in this script to match."
        )

    content = content.replace(SECRETS_MANAGER_BLOCK, LOCAL_TEST_BLOCK)
    with open(dst_path, "w") as f:
        f.write(content)


if __name__ == "__main__":
    main()
