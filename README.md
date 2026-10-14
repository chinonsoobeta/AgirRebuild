# Agir V2

Governed underwriting for real-estate development deals: from the deal documents to an
investment-committee decision, where every number traces to a document, an analyst's
decision or a named default, and a run blocks rather than guesses.

V2 is a ground-up rebuild. Nothing is ported from V4; V4's test deals are reused as data
under `oracles/`. The build plan is in [docs/plan.md](docs/plan.md); what is verified, on which branch,
and still open is in [docs/STATUS.md](docs/STATUS.md).

## Run it

```bash
npm install
npm start          # builds the web app, then serves it and the API on http://127.0.0.1:8787
```

The first start migrates an embedded Postgres (PGlite) in `.data/`, seeds six reference
deals by uploading real PDF, Excel and CSV files through the normal pipeline, runs three of
them, and renders one IC memo. On the sign-in page, "Continue as Dana Analyst" signs in
without a password (development only). Rowan Reviewer is a second admin, for dual control
and committee decisions.

For development with hot reload: `npm run dev` (API on :8787, Vite on :5173).
To start empty: `AGIR_SEED=0 npm start`. To reset: delete `.data/`.

## Check it

```bash
npm run gate -- --tier=release   # typecheck, every test, web build
```

## What is where

| Path | What it is |
|---|---|
| `packages/contracts` | Every field, metric, status and policy threshold, declared once |
| `packages/engine` | The pure underwriting engine: one monthly ledger, stresses, checks, verdict, readiness |
| `packages/numbers` | Number tokenizer that detects a document's format and refuses ambiguous numbers |
| `packages/extraction` | Parsers (PDF, XLSX, CSV, DOCX, text), candidate finders, field mapping, consolidation |
| `packages/artifacts` | IC memo, lender package, model export; provenance by construction plus a scan |
| `packages/db` | SQL migrations (schema, governed functions, row-level security), storage |
| `packages/testkit` | Loads the reference deals and turns them into real files |
| `apps/api` | Hono API: sessions, governed use cases, audit package |
| `apps/worker` | Job runner: verify, read, extract, reconcile, render |
| `apps/web` | React app in the Ink & Signal design |
| `oracles/deals` | Six reference deals with their expected outcomes |

## Rules the code enforces

- Only the engine produces numbers. A model may suggest a label for a figure the reader could not label, only when a workspace owner turns that on; a person confirms it, and a model never supplies a value.
- The engine reads only approved or explicitly default-accepted inputs. Missing, conflicting,
  pending or out-of-range inputs block the run and are named.
- A conflict resolves only to a documented value. Overriding a material field needs a written
  reason and a second, different approver (enforced in the database).
- "Not meaningful" and "not applicable" are statuses, never zero; the database refuses a
  measured metric without a value.
- The verdict is computed once per run and stored; memos and reports read it.
- Runs are append-only, content-hashed, signed and replayable; the audit log is hash-chained.
- The browser never touches the database; signed-in queries run under row-level security.
