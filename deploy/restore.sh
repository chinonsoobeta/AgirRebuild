#!/usr/bin/env bash
# Restore a backup into an empty stack (new volumes), then start it.
#   deploy/restore.sh <agir-db-....dump> [agir-blobs-....tar]
# Refuses if the database already has tables. COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES
# select the stack, as for backup.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dump="${1:?usage: restore.sh <db.dump> [blobs.tar]}"
blobs="${2:-}"
dc() { docker compose -f "$here/compose.yml" "$@"; }
psql() { dc exec -T postgres psql -U agir -d agir -v ON_ERROR_STOP=1 -qtA "$@"; }

dc up -d --wait postgres
if [ "$(psql -c "select count(*) from pg_tables where schemaname = 'public'")" != "0" ]; then
  echo "The database is not empty; restore only into a new stack (docker compose down -v first)." >&2
  exit 1
fi
# Roles are not in a dump; migration 0003 creates this one, and the dump's grants name it.
psql -c "do \$\$ begin if not exists (select from pg_roles where rolname = 'agir_app') then create role agir_app nologin; end if; end \$\$"
dc exec -T postgres pg_restore -U agir -d agir --no-owner --exit-on-error < "$dump"
echo "database restored from $dump"

if [ -n "$blobs" ]; then
  # A one-off container on the blob volume, as the image's own user.
  dc run --rm --no-deps -T --entrypoint tar api -C /data -xf - < "$blobs"
  echo "blobs restored from $blobs"
fi
dc up -d --wait
