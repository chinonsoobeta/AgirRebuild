# Status and handoff

The durable record for whoever picks this up next: what is verified, what is on which branch,
what is known to be wrong, and what only a person can do. Update it in the same commit as the
work it describes.

## Verified commands

| Command | Result | Verified |
|---|---|---|
| `npm install` | Node 22 (`engines` allows 22 to 24); `.npmrc` sets `legacy-peer-deps` | 2026-10-01 |
| `npm run gate -- --tier=release` | Both typechecks, 159 tests in 9 files (119 on `main`), web build | 2026-10-03, `task/08-plain-language` |
| `VITEST_MAX_WORKERS=2 npm run gate -- --tier=release` | The same gate with two test workers: peak memory about 1 GB, no swap | 2026-10-01 |
| `AGIR_DATA_DIR=<empty folder> PORT=8791 npm start` | Builds the web app, applies `0001` to `0007`, seeds six deals, serves on that port. An empty data folder leaves `.data/` untouched | 2026-10-01, `task/01-deal-currency` |

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
| `task/03-run-reuse` | 2 | A run is reused only when it is the deal's latest run and was made from the same approved inputs, in migration `0005`. Before, a run after a status-only change came back as the out-of-date run before it, and no decision could be recorded. Solo mode needs this: confirming a value changes its status, not its figure | Yes: a migration, and the rule for when a signed run is reused |
| `task/04-solo-mode` | 2 | A workspace owner can switch review to solo. A material value entered by hand is then used at once, and stays labelled sponsor-stated (approved, entered by a person, no second approver) until a different person confirms it, in migration `0006`. The label is derived, so no review path removes it; it is part of the assumptions hash, so confirming makes earlier runs out of date, and runs and review show it | Yes: it relaxes the dual-control rule, and a migration |
| `task/05-agir-review` | 2 | The paid, done-with-you confirmation. An owner grants a person a time-limited `reviewer` role (1 to 90 days) in migration `0007`. A reviewer reads the workspace and may only confirm a sponsor-stated value; every other action is refused, and an expired membership grants nothing. A value they confirm is labelled "Confirmed by Agir review" on review and in a run's inputs, and the label outlives the expiry | Yes: a role, the RLS helpers `agir_is_member` and `agir_require`, and a migration |
| `task/07-artifact-labels` | 2 | Every artifact says which inputs were stated by the sponsor and not confirmed. The lender package and IC memo carry a "Stated by the sponsor, not independently confirmed" block with the count and the inputs, right after the verdict. The inputs appendix and the model export's Inputs sheet label each input as sponsor-stated, confirmed by Agir review (with the date) or confirmed by a named person. Runs made before this label render as before | Advised: it changes what lenders read; no migration or engine change |
| `task/06-quick-start` | 3 | A deal with no documents offers a quick start: a multiplex (2–4 units) or small apartment (5–30 units) template of about 13 plain questions, in English and French, in `TEMPLATES` in `packages/contracts/src/fields.ts`. Answers are entered through the existing manual-entry endpoint (`fn_enter_value`) and the three named defaults are accepted only when the owner ticks the box, through `fn_accept_defaults`. A retry after a partial failure resumes. A test checks that each template covers every required field | Not required: no migration, engine, auth or governance change; it uses the existing governed functions |
| `task/08-plain-language` | 3 | The interface says "DCR" (French "RCD", CMHC's terms) wherever it showed "DSCR" ("RCSD"): one whole-word replacement in the label and message helpers in `apps/web/src/i18n.tsx`, applied at display time because gate labels and check messages are inside the hashed result. One "What these terms mean" disclosure (`Glossary`, `components/ui.tsx`) on Run and Review defines eight terms in English and French. A solo workspace reads "Record your decision" instead of "committee decision". Web only | Not required: display only, no API, engine, contract or migration change |

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
- **"DCR" is shown at display time** (done in `task/08-plain-language`). Gate labels and check messages are part of
  the hashed result, so the stored text still says "DSCR"; the interface replaces the whole word with CMHC's
  "DCR", and in French "RCSD" with "RCD". The glossary keeps the lenders' term ("called DSCR by many lenders").
- **The count of sponsor-stated inputs is derived, not stored** (step 2). It is counted from the run's stored
  input snapshot when an artifact is made, rather than kept as a new run column, because the snapshot already
  holds each input's status and a column would need a migration and could disagree with it. Whether that count
  caps the verdict remains a credit decision (under "Needs a person").
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
