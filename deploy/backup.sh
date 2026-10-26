#!/usr/bin/env bash
# Back up a running compose stack: the database (pg_dump, custom format) and the blobs (a tar
# of the shared volume). Two dated files, nothing else.
#   deploy/backup.sh [out-dir]          (default deploy/backups)
# COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES select another stack, as docker compose reads them.
# With AGIR_BLOB_STORE=s3 the bucket is not copied here: back it up with bucket versioning or
# replication on the provider's side.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/backups}"
dc() { docker compose -f "$here/compose.yml" "$@"; }
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

# The database first: blobs are written before the rows that name them and never deleted,
# so a tar taken after the dump holds every blob the dump refers to.
dc exec -T postgres pg_dump -U agir -d agir -Fc > "$out/agir-db-$stamp.dump"
echo "database: $out/agir-db-$stamp.dump ($(wc -c < "$out/agir-db-$stamp.dump" | tr -d ' ') bytes)"

if [ "$(dc exec -T api printenv AGIR_BLOB_STORE || true)" = "s3" ]; then
  echo "blobs: in the S3 bucket; not copied (use bucket versioning or replication)"
else
  dc exec -T api tar -C /data -cf - blobs > "$out/agir-blobs-$stamp.tar"
  echo "blobs: $out/agir-blobs-$stamp.tar ($(wc -c < "$out/agir-blobs-$stamp.tar" | tr -d ' ') bytes)"
fi
