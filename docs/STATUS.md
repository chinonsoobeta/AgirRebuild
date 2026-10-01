# Status and handoff

The durable record for whoever picks this up next: what is verified, what is on which branch,
what is known to be wrong, and what only a person can do. Update it in the same commit as the
work it describes.

## Verified commands

| Command | Result | Verified |
|---|---|---|
| `npm install` | Node 22 (`engines` allows 22 to 24); `.npmrc` sets `legacy-peer-deps` | 2026-10-01 |
| `npm run gate -- --tier=release` | Both typechecks, 141 tests in 9 files (119 on `main`), web build | 2026-10-01, `task/02-metric-area` |
| `VITEST_MAX_WORKERS=2 npm run gate -- --tier=release` | The same gate with two test workers: peak memory about 1 GB, no swap | 2026-10-01 |
| `AGIR_DATA_DIR=<empty folder> PORT=8791 npm start` | Builds the web app, applies `0001` to `0004`, seeds six deals, serves on that port. An empty data folder leaves `.data/` untouched | 2026-10-01, `task/01-deal-currency` |

`npm start` without `AGIR_DATA_DIR` migrates `.data/` in place, and a migration cannot be undone there.
Point it at an empty folder to try a branch.

The PDF test needs a headless Chromium: Playwright's cache, or `AGIR_CHROMIUM_PATH`
(`packages/artifacts/src/pdf.ts`). CI installs one with `npx playwright-core install --only-shell chromium`.

## Where the work is

There is no remote. Everything is committed locally, and nothing is pushed or merged until the
owner says so. Each task has its own branch, and each branch is stacked on the one before it, because
later tasks build on earlier migrations. Review and merge them in order.

| Branch | Plan step | What it does | Human review (plan rule 7) |
|---|---|---|---|
| `main` | | The rebuild as it stood on 2026-09-24, committed as the baseline | |
| `task/00-status-and-ci` | 0 | This file, the approved plan in `docs/`, the CI gate | |
| `task/01-deal-currency` | 1 | A deal states its currency (CAD unless it says otherwise), country and province when it is created, in migration `0004`. Every report says once which dollar its figures are in, and the model export has a Currency row | Yes: a migration, and a new signature for `fn_create_deal` |
| `task/02-metric-area` | 1 | Areas and rents in m² (and the French pi²) are read from documents and converted to square feet where they are mapped, at 10.7639 SF per m². Each source keeps the unit the document used. Review says a value was converted, and a run's source label quotes the original | Not required: extraction is not on rule 7's list, and no reference deal's values moved. Advised, because it changes how new documents are read |

The plan for small Canadian developers is [plan-small-developers.md](plan-small-developers.md). Release 1 steps 0 to 3 are
being built now. Steps 4 to 6 wait on the people-owned items listed below.

## Known gaps

- **Foreign currency is not detected.** Decision 7 says a foreign currency raises a conflict. The tokenizer
  records only that a token is money (`currency: boolean` in `packages/numbers/src/index.ts`), not which
  currency, so a USD figure in a CAD deal is read as CAD. Bergendal's figures carry no currency mark at all.
- **CI has never run.** `.github/workflows/gate.yml` is written but unexercised until the repo is pushed.
- **French documents are barely read.** Labels are matched only against English aliases, `normalizeLabel`
  drops accented letters, and a trailing dollar sign ("18,75 $") is not read as money. A French line maps
  only when its unit names the field and the label names a component ("Commerce : 9 400 pi²").
- **An area cannot be entered by hand in m².** Review and manual entry take square feet. An m² option
  belongs with the quick-start questions (step 3).
- **A new run can come back as the old one.** A run is identified by its deal, input hash, engine version
  and policy hash, and `fn_persist_run` returns the stored run when those match (`0002_functions.sql`).
  Reopening an accepted default and approving the same value changes the deal's assumptions hash but not
  its input hash. The next run is therefore the old run, which is out of date against the new assumptions
  hash, and a decision is refused until some input value changes. To reproduce: accept a default, reopen
  it, approve it unchanged, then run.

## Deviations from the plan

Where the code showed a better route than [the plan](plan-small-developers.md), the route taken and why.

- **One currency statement per report, not `CA$` on every figure** (step 1). Check messages and gate labels
  are inside the hashed, signed run result, so changing how they print money needs a new engine version
  and would change every stored run. Instead, each report's header line says "All amounts in Canadian
  dollars (CAD)", and the model export has a Currency row. English money formatting is the same in en-CA
  and en-US, so the formatter keeps its locale.
- **A deal created before migration `0004` has no currency**, rather than CAD. Giving old deals CAD would
  infer it from nothing. Their reports say "Currency not stated". New deals get CAD unless they say
  otherwise, and the currency cannot be changed after creation, so all of a deal's runs and reports agree.
- **"DCR" moves to the plain-language layer of step 3.** Gate labels are part of the hashed result, so the
  CMHC term will be shown by the interface, with "DSCR" kept behind the disclosure.
- **One migration per task** (`0004`, `0005`, and so on), not one `0004` for everything. Applied migrations
  are checksummed and the branches are stacked, so a shared file would change under a database that had
  already applied it.

## Needs a person

- The GitHub repository: its name, and the push.
- Reference deals and outcome sheets for the Canadian cases (oracles are people-owned): a fourplex rental
  in Edmonton, a 12-unit MLI Select rental in Halifax, 8 townhomes for sale in Ontario, a 30-unit condo in BC.
  Each needs an independently built workbook.
- Credit sign-off: whether sponsor-stated inputs cap the verdict, `rental_hold_v1`, `for_sale_v1`.
- Cited, dated tables: CMHC MLI Select terms, provincial and municipal land transfer tax, GST/HST rebates,
  presale deposit rules.
- Legal: wording that a memo is not an appraisal or advice; a privacy notice and terms under PIPEDA.
- Accounts: Stripe, Canadian hosting, and GST/HST registration for Agir's own sales.
- Pricing: $99 to $299 per deal is a hypothesis to test with the first customers.
