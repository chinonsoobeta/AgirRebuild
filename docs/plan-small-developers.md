# Agir V2 for small Canadian developers: plan

Approved 2026-10-01. Copied here unchanged so the handoff record in [STATUS.md](STATUS.md) can cite it; where the code
showed a better route, STATUS.md records the deviation and why.

## Context

`~/agir-v2` is the end-to-end rebuild. It was created 2026-09-24 and is the only Agir directory from the last two weeks.

It already has a strong core:
- a pure monthly-ledger engine with 34 metrics, 7 stresses and 5 gates;
- extraction and review with conflicts named;
- runs that are hashed and replayable;
- an IC memo, a lender package and an Excel export, with provenance checks;
- a French (fr-CA) interface.

It was built for institutional teams. Every reference deal costs more than $20M, and the vocabulary and the two-person controls assume a credit committee.

We want to sell it per deal to small Canadian customers:
- **Who:** infill and missing-middle builders and brokers, plus small condo and townhome builders.
  - I've read "brokers" as the mortgage or deal brokers who package these deals for lenders. Brokers can use Release 1 with one workspace per client. Release 3 adds broker conveniences.
- **How:** self-serve, with optional paid Agir review ("done-with-you").
- **Outputs:** a decision to build, a lender package, and a partner memo for raising equity.

The governance rules stay intact: only the engine produces numbers, gaps block a run, and the system never guesses.

The work happens in `~/agir-v2`, which is outside this session's folder, so I'll ask to add it before editing. It follows `docs/plan.md` "Rules for agent-built work":
- one task per PR;
- the failing test lands first;
- oracles are owned by people;
- human review for engine, policy, RLS, auth and migrations.

### Gaps found in the code

| Gap | Evidence |
|---|---|
| A solo user can't run a deal. A hand-entered or overridden material value (exit cap, loan amount, rate, amortization) waits for a *different* person to approve it. | `packages/db/migrations/0002_functions.sql:249-271` (`modify`, `second_approve`), `:291-325` (`fn_enter_value`) |
| Money is hardcoded to USD and en-US formatting. There is no currency per deal. | `packages/artifacts/src/format.ts:12-24`, `packages/engine/src/checks.ts:4` |
| Area is square feet only. The planned m² conversion isn't built. | `packages/contracts/src/fields.ts`, `packages/numbers/` |
| No Canadian costs or financing: no CMHC/MLI Select, GST/HST, land transfer tax or development charges. Province is free text that drives nothing. | `fields.ts`, `docs/spec/economic-model.md` |
| The only exit is a sale at a cap rate. There is no exit by refinancing and holding, and no for-sale (condo or townhome) model. | `engine/src/ledger.ts`, `economic-model.md` |
| Inputs are 48 fields with about 12 always required. Extraction expects clean "label: value" documents. Scanned PDFs are refused because there is no OCR. | `fields.ts`, `apps/worker/src/index.ts:87-88` |
| No billing, no share links, no password reset, no deployment. The git repo has no commits yet; `.gitignore` is already in place. | Explore report, `git status` |
| Memos are tables only and in English only. | `packages/artifacts/src/model.ts` |

## Approach

Ship in three releases. Rental infill comes first because the engine already models rental holds. For-sale needs a new exit mode and comes second.

### Release 1: rental infill, self-serve plus review

**0. Housekeeping**
- Create the GitHub repo (needs a person: the name).
- Make the initial commit and add `docs/STATUS.md` as the handoff record.
- Add `npm run gate -- --tier=pr` to CI.

**1. Canadian units and formatting**
- Add a `currency` per deal (CAD by default) and a `country` and `province` per deal, in a new migration.
- Make `format.ts` and engine messages in `checks.ts` take a locale. Use en-CA and fr-CA formatting, and make `CA$` explicit in artifacts.
- Convert m² to square feet at entry, which `docs/plan.md` decision 7 already promised. The tokenizer gets m², "sq m" and "pi²" units, and the original unit is kept in provenance.
- Use Canadian terms: show the coverage gate as "DCR" (the CMHC term) and keep "DSCR" as an alias.

**2. Solo mode that keeps the governance**
- Add a workspace `review_mode`: `team` (today's behaviour), `solo` or `agir_review`.
  - Only the owner can change it.
  - Each change is an audit event, and each run records the mode it ran under.
- **Solo:** `fn_enter_value` and the `modify` action approve a material value from its sole owner, with the written reason they already require.
  - There is no new engine-readable status.
  - A material, analyst-sourced value with no second approver is *sponsor-stated*. Every artifact labels it "Stated by the sponsor, not independently confirmed", and the lender package lists these values on page 1.
  - The run stores how many material inputs are sponsor-stated. Whether that caps the verdict at "with conditions" is a **credit decision**.
- **Agir review** is the paid done-with-you option.
  - The customer asks for review. That grants an Agir reviewer a time-limited workspace membership with a new `agir_reviewer` role, which can view and `second_approve` only. The role is added in `0002_functions.sql:14` and `0003_access.sql`.
  - Values confirmed this way are labelled "Confirmed by Agir review" with the date.
  - The grant and its expiry are audit events.
- This relaxes a rule the README says the database enforces, so it needs human review before it merges.

**3. Quick start by deal type**
- Add templates in `contracts`: "Multiplex rental (2–4 units)" and "Small apartment (5–30 units)".
- Each template asks about 12–15 questions in plain language. The answers go through the existing `fn_enter_value`.
- Named defaults (hold period, selling costs, expense ratio) are shown and accepted explicitly through `fn_accept_defaults`, never applied silently.
- Fields that don't apply, such as mezzanine, are hidden and their `absentMeans` is stated.
- Documents become optional evidence. Extraction still runs on anything uploaded, and disagreement with the typed values is named as a conflict.
- Add a plain-language layer in `apps/web/src/i18n.tsx`. Each term gets a short definition on the Review and Run screens, and the institutional term stays available behind a disclosure.
- For a solo owner, the decision step is labelled "Record your decision". Owners already outrank the admin check at `0002_functions.sql:408`.

**4. Canadian financing and costs**

All rates and terms here are people-owned, dated, cited policy data. They are versioned like `POLICY_V1` and never defaulted silently.
- **CMHC MLI Select (5+ units):**
  - The insurance premium is a cited percentage of the loan, capitalized into the loan balance in the ledger.
  - Amortization goes up to the cited maximum. `senior_amort_years` already allows 50.
  - The DCR floor and loan-to-value (LTV) or loan-to-cost (LTC) ceilings by points tier come from a cited table.
  - The run is blocked if there are fewer than 5 units.
- **Conventional financing:** for 2–4 unit buildings.
- **Exit by refinancing and holding:** add `exit_mode = refinance_hold`. It builds on the existing refinance (`refinance_month`, `refinance_amount`) and has no sale leg.
  - It reports cash returned at refinance, cash left in the deal, stabilized DCR and cash-on-cash.
  - How IRR and multiple are measured without a sale is a spec decision in `docs/spec/economic-model.md`. Either an unrealized value is labelled as such, or they are `NOT_APPLICABLE`. Never 0.
- **Canadian cost lines:**
  - **Development charges / DCCs:** required, *no default*, because they vary by municipality.
  - **Land transfer tax:** computed from a cited, dated provincial and municipal table. Where the table has no entry, the run asks for the amount.
  - **GST/HST on new rental construction (self-supply) and the rental rebate:** an explicit line from a cited table, flagged for review.
  - **Property tax:** its own operating cost line.
- **Policy profile per strategy:** `rental_hold_v1`, where the coverage gate uses the financing type's floor. It needs credit sign-off before it applies.

**5. Three outputs from one persisted run.** These go in `packages/artifacts`, and the provenance scan is unchanged.
- **Build decision:** a plain-language summary of one or two pages: verdict, the three numbers that matter, the weakest stress, and the sponsor-stated values. The text comes only from templates over computed values, with no model-written prose.
- **Lender package:** exists. Add the CMHC fields, sponsor-stated values first, and a sources appendix.
- **Partner memo:** uses the existing LP/GP waterfall (`engine/src/waterfall.ts`) and shows returns per partner class.

**6. Ready to sell**
- **Deployment:** Canadian data residency.
  - Managed Postgres in a Canadian region (the API already takes `DATABASE_URL`).
  - Canadian object storage behind the existing `BlobStore` interface (`packages/db/src/storage.ts`).
  - Chromium for PDFs in the worker container.
  - Backups.
- **Accounts:** password reset and email verification (the API has its own scrypt and cookie auth).
- **Billing:** Stripe in CAD with GST/HST collected through Stripe Tax.
  - A credit unlocks reports for one deal, including its later re-runs, for a set period. Running a deal and exploring it stay free.
  - Agir review is a separate add-on.
- **Sharing:** read-only expiring links to an artifact plus its audit package, for lenders and partners.
- **Privacy:** a privacy notice and terms under PIPEDA. These need a person.

**Order inside Release 1:**
1. Do steps 0, 1, 2 and 3. A solo owner can then take a small rental from the quick start to a lender package on the existing sale exit.
2. Do steps 4 and 5 in parallel, once a person has sourced the cited tables.
3. Do step 6, which is the launch.

### Release 2: townhomes and small condos for sale
- Add the spec section first: `economic-model.md` § for-sale, plus reference workbooks. No engine code before both exist.
- Add `exit_mode = for_sale`. Its inputs are:
  - unit prices and an absorption schedule;
  - presale percentage and deposit schedule. Whether deposits can be used varies by province, so it comes from a cited table;
  - sales commissions;
  - GST/HST on new home sales and the new housing rebate, from a cited table;
  - a construction loan conditional on a presale threshold.
- Its metrics are profit on cost, margin on revenue, peak equity and IRR. DCR and exit cap rate are `NOT_APPLICABLE`.
- Add a `for_sale_v1` policy profile, which needs credit sign-off.
- Add the "Townhomes for sale" and "Small condo" quick-start templates.

### Release 3: brokers and harder documents
- **Brokers:** one account managing many client workspaces, an invite so a client can confirm their own values, and the broker's logo on the lender package.
- **OCR:** the fallback from plan task X3, with confidence recorded. Small builders often send scanned documents.
- **French artifacts:** memos in fr-CA, after review by a qualified translator.

## Reference deals to add (people-owned, before engine work)

- a fourplex rental, conventional loan, Edmonton;
- a 12-unit MLI Select rental with refinance-and-hold, Halifax;
- 8 townhomes for sale, Ontario (Release 2);
- a 30-unit condo with presales and GST, BC (Release 2).

Each needs an outcome sheet in the same format as `oracles/deals/*.json`, and an independently built Excel workbook.

## Needs a person

- The GitHub repo name.
- Credit sign-off on `rental_hold_v1`, `for_sale_v1` and whether sponsor-stated inputs cap the verdict.
- Sourcing and dating the cited tables: CMHC MLI Select terms, provincial and municipal land transfer tax, GST/HST rebates, deposit rules.
- Legal: wording that the memo is not an appraisal or advice, plus the PIPEDA notice and terms.
- Stripe and hosting accounts, and GST/HST registration for Agir's own sales.
- Pricing. The $99–299 per deal range is a hypothesis to test with the first customers.

## Critical files

- **Contracts:** `packages/contracts/src/{fields,policy,statuses,metrics}.ts`. These hold the review modes, Canadian fields, exit modes and policy profiles.
- **Database:**
  - `packages/db/migrations/0002_functions.sql` has `fn_enter_value`, the assumption actions and the role ranks.
  - `0003_access.sql` has RLS for the reviewer role.
  - All changes go in a new `0004_*.sql`.
- **Engine:** `packages/engine/src/{ledger,underwrite,verdict,checks}.ts` for the financing premium, exit modes and profile-aware gates.
- **Units:** `packages/numbers/src/index.ts` for m².
- **Artifacts:** `packages/artifacts/src/{format,model,html,docx,xlsx}.ts` for CAD and en-CA, labels, and the three outputs.
- **Web:** `apps/web/src/i18n.tsx` and `apps/web/src/routes/*` for the quick start, plain language and solo decision labels.
- **API:** `apps/api/src/app.ts` for billing, share links and account flows.

## Verification

- `npm run gate -- --tier=release` stays green, and all six existing reference deals keep their outcomes. Any number that moves ships with a diff table, per plan rule 6.
- The new Canadian reference deals must:
  - run from the quick start alone;
  - run again from documents;
  - match their workbooks within tolerance;
  - block with named reasons when the development-charge line or a cited table is missing.
- **Solo flow test:** one account takes the fourplex from the quick start to a paid lender package, with every sponsor-stated value labelled. The same deal under `agir_review` shows "Confirmed by Agir review". A `team` workspace still refuses self-approval of a material value.
- Every artifact passes the provenance scan with zero orphan numbers, shows CA$, and shows m² inputs in their original unit.
- **In the browser** (`npm start`): walk the 12-unit MLI deal through documents, review, run and the three reports, then open its share link from a signed-out session.
