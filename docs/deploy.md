# Deploying Agir

A recipe for one host with Docker: Postgres, the API and the worker, from one image. It is the engineering half
of plan card 158. It does not provide TLS, a mail provider, encryption at rest, a KMS or a malware scan (see "Not
done" below).

## The pieces

- `deploy/Dockerfile`: one image, `node:22-bookworm-slim`. It runs `npm ci`, builds the web app and installs
  Playwright's headless Chromium with its system packages. It runs as the non-root `node` user, through `tsx` as
  the scripts do. Two commands:
  - API (the default): `node_modules/.bin/tsx apps/api/src/main.ts`
  - Worker: `node_modules/.bin/tsx apps/worker/src/main.ts`
- `deploy/compose.yml`: `postgres:16` on the named volume `pgdata`; `api` and `worker` from the same image with the
  same settings and the same `blobs` volume at `/data`. The API publishes `127.0.0.1:${AGIR_HOST_PORT:-8787}`.
- `deploy/.env.example`: copy to `deploy/.env` (git-ignored) and fill in.

```bash
cp deploy/.env.example deploy/.env      # fill in the secrets
docker compose -f deploy/compose.yml up -d --build
```

TLS terminates in front of the API, in a proxy or load balancer you run (with HSTS, per ADR 0002 §3.1). Nothing in
`deploy/` listens on a public address. Set `AGIR_TRUST_PROXY=1` only when exactly one proxy sets `x-forwarded-for`.

## The two processes

The API serves the web app and the API and, with `DATABASE_URL` set, does not run jobs. The worker runs every job:
checking, reading and extracting documents, reconciling, and rendering memos (the PDF needs Chromium, so the worker
image needs it). With no `DATABASE_URL` (embedded PGlite) the API runs the worker in its own process, and
`AGIR_EMBEDDED_WORKER=1` forces that on Postgres too.

Both apply migrations at start. In compose the worker starts only after the API answers `/api/health`, so the two
never migrate at once. Elsewhere, start the API first.

## The shared store rule

The API writes uploaded files into the blob store and the worker reads them; the worker writes rendered memos and the
API serves them. **Both must use the same store.** A mismatch fails silently at first: uploads succeed, then every
document fails in the worker. Both processes read the same variables and open the store through one function
(`openStore` in `packages/db/src/startup.ts`); in compose they share one environment block.

- File store (the default): `AGIR_DATA_DIR/blobs`. Both containers mount the same volume. In production the process
  logs one warning line at start, because the files are on the local disk; a persistent volume is a valid pilot
  choice.
- S3 store: `AGIR_BLOB_STORE=s3` with a bucket in any S3-compatible service. Keys are the same as the file store's
  (`xx/sha256`), content-addressed; a file already stored is not sent again.

## The startup check

Both processes run `checkStartup` (`packages/db/src/startup.ts`) before opening anything, and exit 1 with one line:

- `DATABASE_URL` set and `AGIR_ENV` unset: refused. Without `AGIR_ENV` the code would be development: the demo deals
  seeded, the demo sign-in published, cookies without `Secure`, runs signed with a development key.
- `AGIR_ENV` other than `development`, `test` or `production`: refused.
- Production: `DATABASE_URL`, `AGIR_RUN_SIGNING_SECRET` and `AGIR_PUBLIC_ORIGIN` are required; `AGIR_SEED=1` is
  refused.
- `AGIR_BLOB_STORE=s3` without `AGIR_S3_BUCKET` or `AGIR_S3_REGION`, or an unknown `AGIR_BLOB_STORE`: refused.

## Variables

| Variable | Read by | Meaning |
|---|---|---|
| `AGIR_ENV` | both | `development`, `test` or `production`. Unset is development, unless `DATABASE_URL` is set |
| `DATABASE_URL` | both | Postgres. Unset: embedded PGlite in `AGIR_DATA_DIR/pg` |
| `AGIR_DATA_DIR` | both | Data folder: `pg/` (PGlite), `blobs/` (file store), `mail/` (development email). Default `.data` |
| `AGIR_RUN_SIGNING_SECRET` | both | The key runs are signed with. Required in production; keep it for the life of the data |
| `AGIR_PUBLIC_ORIGIN` | API | The address people use; links in email are built from it. Required in production |
| `AGIR_BIND` | API | Listening address. Default `127.0.0.1`; `0.0.0.0` in the image |
| `PORT` | API | Listening port. Default 8787 |
| `AGIR_TRUST_PROXY` | API | `1` when exactly one proxy in front sets `x-forwarded-for` |
| `AGIR_SEED` | API | `0` starts development empty. Production never seeds, and refuses `1` |
| `AGIR_EMBEDDED_WORKER` | API | `1` runs the worker inside the API on Postgres too |
| `AGIR_SIGNUP` | API | `open` (default) or `invite`: during the pilot only a client invitation creates an account (card B) |
| `AGIR_ALERT_URL` | API | Where an alert is POSTed as JSON (a refused start, a failed migration, an unhandled error, a failed email, a dead job). Unset: no alerts (card B) |
| `AGIR_BLOB_STORE` | both | `file` (default) or `s3` |
| `AGIR_S3_BUCKET`, `AGIR_S3_REGION` | both | Required with `s3` |
| `AGIR_S3_ENDPOINT` | both | Another S3-compatible service; path-style addressing is used with it |
| `AGIR_S3_PREFIX` | both | Put in front of every object name, e.g. `agir/` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | both | The S3 credentials, read by the AWS SDK (or its other usual sources) |
| `AGIR_CHROMIUM_PATH` | worker | A headless Chromium for the PDF. Unset: Playwright's cache. The image sets `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` |
| `ANTHROPIC_API_KEY` | worker | Turns on AI reading. Unset or empty: the rule reader alone reads, and no model is called |
| `AGIR_READER_MODEL` | worker | The reading model. Default `claude-opus-5-5` |
| `AGIR_SUGGEST_MODEL`, `AGIR_SUGGEST_EFFORT` | worker | The label-suggestion model and effort. Defaults `claude-opus-5-5`, `medium` |

## Backups and the restore drill

- `deploy/backup.sh [out-dir]` writes two dated files (default `deploy/backups/`, git-ignored): `agir-db-<UTC>.dump`
  (`pg_dump -Fc`, run inside the postgres container) and `agir-blobs-<UTC>.tar` (the `blobs` folder of the shared
  volume). The dump is taken first: blobs are written before the rows that name them and never deleted, so the tar
  holds every blob the dump refers to. With the S3 store the bucket is not copied; back it up with bucket versioning
  or replication on the provider's side.
- `deploy/restore.sh <dump> [tar]` restores into an empty stack: it starts Postgres alone, refuses a database that
  already has tables, creates the `agir_app` role (roles are not in a dump), runs `pg_restore --no-owner`,
  unpacks the blobs into the volume, then starts the stack. The API's migration check then finds every migration
  applied and unchanged.
- Both read `COMPOSE_PROJECT_NAME` and `COMPOSE_ENV_FILES`, as `docker compose` does, to choose a stack.

The drill, run once on 2026-10-25 with Docker 29 and Compose 5.6 (colima, arm64), image 1.87 GB: the stack started
on fresh volumes, the API applied every migration on Postgres 16, and the standalone worker read an invented
document set (six files, `maple-heights` from `oracles/`) uploaded through the API by a new account, the deal ran,
and the worker rendered the IC memo PDF. `backup.sh` wrote both files; `docker compose down -v` destroyed the stack;
`restore.sh` brought it back with 1 deal, 6 documents, 1 run, 1 ready memo, 53 audit events (the chain verifies) and
7 blobs, and the API applied no migration. Signed in again, the six document files and the memo PDF downloaded.
A second `restore.sh` on the restored stack refused, as the database was not empty.

## Not done

Per ADR 0002, still to build before real documents: TLS and HSTS at the edge, and TLS to Postgres
(`sslmode=verify-full`); envelope encryption of blobs and a KMS (S1, S4); the worker jail: read-only root, an egress
allow-list, Chromium's sandbox, ClamAV (S3); a mail provider (production sends no email today); off-host copies and
a schedule for the backups.
