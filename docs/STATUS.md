# Status and handoff

The durable record for whoever picks this up next: what is verified, what is on which branch,
what is known to be wrong, and what only a person can do. Update it in the same commit as the
work it describes.

## Verified commands

| Command | Result | Verified |
|---|---|---|
| `npm install` | Node 22 (`engines` allows 22 to 24); `.npmrc` sets `legacy-peer-deps` | 2026-10-01 |
| `npm run gate -- --tier=release` | Both typechecks, 119 tests in 8 files, web build | 2026-10-01, `main` at `e590a73` |
| `VITEST_MAX_WORKERS=2 npm run gate -- --tier=release` | The same gate with two test workers: peak memory about 1 GB, no swap | 2026-10-01 |
| `npm start` | Builds the web app, migrates and seeds `.data/`, serves http://127.0.0.1:8787 | not re-run since the rebuild |

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

The plan for small Canadian developers is [plan-small-developers.md](plan-small-developers.md). Release 1 steps 0 to 3 are
being built now. Steps 4 to 6 wait on the people-owned items listed below.

## Known gaps

- **Foreign currency is not detected.** Decision 7 says a foreign currency raises a conflict. The tokenizer
  records only that a token is money (`currency: boolean` in `packages/numbers/src/index.ts`), not which
  currency, so a USD figure in a CAD deal is read as CAD. Bergendal's figures carry no currency mark at all.
- **CI has never run.** `.github/workflows/gate.yml` is written but unexercised until the repo is pushed.

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
