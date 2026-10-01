# Agir V2 build plan

## Context

Agir V4 (`~/agirprofinance`, latest branch `frontend/wave1-wave2-remediation`) proved the product idea: governed underwriting for real-estate development deals, from deal documents to an investment-committee decision, where every number traces to a document, an analyst decision or a named default, and the run blocks rather than guesses. It also accumulated structural defects that three audits (Jul 27, Jul 30, Aug 1) could only patch: three stacked economic models, a verdict recomputed in three places, no seam between computing and saving, NULL meaning two things, extraction that silently corrupts non-US numbers, checks that catch disagreement but never absurdity, ~20k lines outside the core, and 16 overlapping gates.

V2 is a ground-up rebuild in a new repository. **Nothing is ported**: not the engine, not the extraction, not the UI. V4 is used three ways only: its specs and audits are read for intent, its test documents and deal scenarios are reused as test data, and V4 is run as a comparison point whose differences must each be explained.

Settled inputs to this plan:
- Stack: TypeScript monorepo on Supabase (Postgres, Auth, Storage), containers on OpenShip.
- The 8 decisions from the analysis are adopted (listed below). Decisions 1, 2 and 8 still get a credit sign-off with the reference-deal diffs before the engine ships.
- Builders: mostly AI agents, with Chinonso and Anthony reviewing merges. The plan is therefore cut into small, independently checkable tasks, and the checks are owned by people, not by the agents doing the work.

## Adopted decisions

1. **DSCR:** the gate reads *sizing DSCR* = whole-stack amortizing debt service on the debt outstanding in each hold year, weakest year, combined stress. *Contractual DSCR* (what is actually due, incl. interest-only) is shown and tested against any stated covenant.
2. **Financing interest:** calculated by the ledger from monthly draws across every tranche and capitalized into TDC. A stated interest reserve is a check (flag when underfunded), not an input. Construction and lease-up months become required.
3. **Multiple IRRs:** status `NOT_MEANINGFUL` with every root listed; IRR is not a gate, so the verdict is unaffected.
4. **No V4 replay.** V2 versions its own engine from the first release, and every run stays replayable.
5. **Scope:** underwriting core only (in/out list in Phase 0, S1).
6. **Extraction:** always a background job, one code path in every environment.
7. **Numbers and units:** number format detected once per document; an ambiguous token yields no candidate; Unicode minus normalized; engine canonical in SF and one currency per deal; m² converted at entry; foreign currency raises a conflict.
8. **Expense growth:** fixed part grows at expense growth; variable part is a share of that year's EGI; a single ratio means fixed dollars. No per-deal switch.

## Architecture

### Repository (new repo, e.g. `Agir-Underwriting-Platform/agir-v2`, local `~/agir-v2`)

```
packages/
  contracts/   field catalog, metric catalog, policy, zod schemas, error codes, API types
  engine/      pure: validate -> ledger -> projections -> stresses -> checks -> verdict; version registry
  numbers/     locale-aware number and unit tokenizer (pure)
  extraction/  normalized document model -> candidates -> field mapping -> conflicts (pure)
  artifacts/   memo and lender-package models, renderers, provenance
  db/          SQL migrations, checksum manifest, generated types, query modules
  testkit/     reference-deal loaders, oracle comparers, corpus scorer, document generators
apps/
  api/         Hono + zod HTTP API; serves the built web app
  worker/      job runner: upload verification, parsing, OCR, extraction, PDF rendering
  web/         React + Vite SPA, TanStack Router/Query, Tailwind + shadcn/ui, i18n (en, fr-CA)
oracles/       reference deals, expected outcomes, reference workbooks, extraction golden maps
docs/spec/     the V2 specification;  docs/adr/  stack and design decisions
```

Default libraries (each confirmed by an ADR in Phase 0): pnpm + Turborepo, Node 22, TypeScript strict, Vitest, fast-check (property tests), Stryker (mutation tests), Playwright; Kysely over Postgres; pdf.js for PDF text with positions, tesseract.js for OCR, SheetJS or exceljs for spreadsheets, mammoth for DOCX; HTML templates rendered to PDF by headless Chromium in the worker, `docx` for Word, exceljs for Excel; ClamAV REST sidecar; Sentry or a webhook error sink.

### Runtime

- **Browser** talks only to the API. It never queries the database (Supabase is used in the browser for sign-in only).
- **API** verifies the Supabase JWT and runs each request's queries in a transaction with `set local role authenticated` plus the caller's claims, so row-level security applies to every API query. State changes that carry rules (approve, second-approve, persist run, record decision) are Postgres functions that enforce the transition, write history and append the audit event in one transaction.
- **Worker** drains a `jobs` table (`FOR UPDATE SKIP LOCKED`, lease, retry, dead-letter). The same worker runs locally and in production.
- **Storage:** one private Supabase Storage bucket; uploads through signed URLs to a pending path.
- **Deploy:** OpenShip compose with `api`, `worker`, `clamav`; a Supabase project per environment.

### Data flow

upload -> verify job (size, type sniff, SHA-256, AV fail-closed, dedupe) -> parse job (normalized document) -> extract job (candidates, mapping, conflicts) -> assumptions (review) -> readiness -> run (`underwrite()` pure, then one persist function) -> decision -> artifacts (worker, from the persisted run only) -> audit package.

### Structural answers to V4's defects

| V4 defect | V2 rule |
|---|---|
| Three economic models | One monthly ledger. Every metric is declared once in the metric catalog as a projection of the ledger; no other code computes a metric |
| Verdict recomputed in three places | The engine computes gate results once; the run stores them; memo, reports and UI only read them |
| No compute/persist seam | `underwrite(input, policy) -> RunResult` is pure and complete; the API does load -> underwrite -> persist in one DB function |
| NULL meant "missing" and "not applicable" | Every metric carries `VALID`, `NOT_APPLICABLE` or `NOT_MEANINGFUL`; a DB CHECK enforces value NULL exactly when status is not `VALID` |
| Review queue and engine tables drifted | One `assumptions` table (field key plus optional item key for revenue components and budget lines); engine input is built from approved rows directly |
| "Latest" tables mirrored run tables | Only run-scoped tables; "latest" is a view |
| Browser JWT client could write governed tables | No browser DB access; RLS still enforced on API queries; rule-bearing transitions are DB functions |
| Inline and queued extraction paths | One asynchronous path everywhere |
| Non-US numbers corrupted silently | Per-document format detection; ambiguity produces no candidate |
| Checks only compared documents | Absolute bounds too: LTC ceiling, non-negative equity, exit not before stabilization, valid components named |
| 16 gates, some matching strings | One `pnpm gate --tier=fast|pr|release`; behavioural tests only |
| Unsaved client-side sensitivity | Deferred; returns later as a server-side, non-exportable scratch mode |
| Provenance only by scanning output | Provenance by construction (every formatted number carries its source reference) plus the token scan as a backstop |
| Stranded, uncommitted agent work | One repo, PR-only, every agent session ends with a pushed branch |

## Oracles and test data

People own these; implementing agents may not edit them (CODEOWNERS).

- **Reference deals (15):** the 12 stress deals (Cascade Row, Dominion Exchange, Northgate Cold Storage, Solstice Tower, Lantern Fields, Kestrel Wharf, Bergendal Kvarter, Ashgrove Commons, Thornbury Mill, Marisol Heights, Calder Point, Willowbrae Terrace) and the 3 demo packages (Harbour Centre, Rivergate, Summit Point). Source: document definitions in V4 `scripts/stress-test-deals.mjs`, `scripts/stress-test-deals-2.mjs`, `src/test/fixtures/{rivergate,summit-point}`, `~/Downloads/Agir_V2_Complex_Test_Package`. Each gets an expected-outcome sheet under V2 conventions: blocked or not and why, conflicts that must be named, verdict, key metrics with tolerances.
- **Reference workbooks:** formula-driven Excel models built from the V2 economic spec by someone (or a separate agent session) with no access to the V2 engine code, covering at least baseline, interest-only, mezzanine, refinance, lease-up ramp, S-curve, equity wipeout, per-SF commercial and waterfall. `~/outputs/agir_excel_parity_package` and V4 `src/test/fixtures/excel-parity` are starting points, updated to V2 conventions.
- **Extraction corpus and golden maps:** V4 `src/test/fixtures/extraction-corpus` trap files, the reference-deal documents, and a regenerated synthetic set; each document has a golden map of field, value and location.
- **V4 comparison:** V4 is run over the same deals; every V2 difference must cite an adopted decision or a named V4 defect, or it blocks.

## Phases

Each task is one PR. Task IDs are stable so agents and reviewers can reference them.

### Phase 0: specification, oracles, scaffold (people-bound)

Spec (`docs/spec/`), drafted by agents from V4 docs, approved by people:
- **S1** Product scope: personas, the workflow, in/out list. In: workspaces and roles, deals, documents, extraction and review, runs with stresses, verdict, recorded committee decision, IC memo, lender package, Excel model export, audit trail and package. Out for now: permits, properties, integrations, portfolio analytics, milestones, Copilot/Insights, markets, SSO/SCIM, webhooks, committee voting, sensitivity.
- **S2** Economic model spec: V4 `docs/architecture/economic-model-v3.md` conventions plus decisions 1, 2, 3 and 8, the absolute bounds, and every formula.
- **S3** Field catalog and metric catalog (seeded from V4 `src/lib/assumption-taxonomy.ts`, `src/lib/dual-control.ts`, `src/lib/engine/input-assembly.ts`): per field its unit, kind, required, material, conservative direction, default, extractable, aliases, and whether it is an output-like quantity that must never become an input (projected NOI, target IRR, valuation).
- **S4** Policy v1: gate thresholds (V4: multiple 1.5x, margin 15%, spread 100 bps, stressed sizing DSCR 1.20x, stressed multiple 1.0x), LTC ceiling, stress set (V4 `src/lib/engine/scenarios.ts`: six plus combined). **Credit sign-off.**
- **S5** Extraction spec: number formats, candidate rules (value-first and label-first), table readers, mapping, conflicts, duplicates and supersession.
- **S6** Review and decision state machine: states, transitions, actors, dual control, defaults, deciding against the verdict (requires a reason).
- **S7** Security and tenancy: role matrix, RLS rules, upload limits, rate limits, audit events.
- **S8** ADRs for the stack defaults above.
- **S9** Finish the design template: draw the Decision and Reports steps, Settings, and the empty, loading and error states; approve it.

Oracles: **O1** reference-deal outcome sheets; **O2** reference workbooks; **O3** extraction golden maps.

Scaffold:
- **R1** Repo, packages, strict TS, lint rules (no `.only`/`.skip` in required suites, no tests that read source/migration/doc text), CODEOWNERS, branch protection, `pnpm gate` tiers.
- **R2** One-command local dev: Supabase, api, worker, web.
- **R3** Migration checksum manifest; the gate fails if an applied migration changes.
- **R4** Staging skeleton on OpenShip and Supabase, health endpoint, error sink, structured logs with request, run and job ids.

Exit: S1-S8 approved, O1-O3 committed, `pnpm gate --tier=pr` green on the empty skeleton, staging serves the health endpoint.

### Phase 1: engine (`packages/engine`, pure, no I/O, no clock)

- **E1** Input schema and validation; invalid components rejected by name.
- **E2** Timeline grid (half-open phases, each rounded separately, sale month).
- **E3** Cost placement: land at month 0, straight-line or S-curve draws, exact cent allocation.
- **E4** Senior loan: balances, interest-only and amortization, construction interest on the actual balance, capitalized; payoff at the sale month.
- **E5** Revenue and opex: components per-unit and per-SF, occupancy, growth, the fixed/variable rule, lease-up ramp.
- **E6** Sale and terminal flow with the non-recourse floor on the sale leg.
- **E7** Projections and the metric catalog with statuses; XIRR with all roots.
- **E8** DSCR family (decision 1).
- **E9** Stresses as full re-runs.
- **E10** Checks: agreement checks plus absolute bounds; risk register.
- **E11** Verdict with stored gate records (`APPROVE`, `APPROVE_WITH_CONDITIONS`, `REJECT`, `NOT_EVALUATED`).
- **E12** Readiness: assumptions to ready or blocked with named reasons.
- **E13** Mezzanine; **E14** refinance; **E15** equity draw timing; **E16** LP/GP waterfall.
- **E17** Version registry, canonical input hashing, replay.
- **E18** Quality bars: property tests (sign conventions, stress monotonicity, NaN never becomes 0, sources equal uses), mutation score threshold, performance budget.
- **E19** V4 comparison report.

Exit: all O2 workbooks match within tolerance; the O1 engine-level outcomes hold (Solstice, Ashgrove, Thornbury, Kestrel, Marisol, Calder, Willowbrae monotonicity, and the negative-equity case now rejects); E19 fully explained; credit sign-off on decisions 1, 2 and 8 from the diff table.

### Phase 2: platform (`packages/db`, `apps/api`, worker skeleton), parallel with Phase 1

- **P1** Tenancy and deals schema.
- **P2** Documents, jobs, candidates.
- **P3** Assumptions and history; transition functions (approve, modify, second-approve, reject, resolve conflict, accept defaults).
- **P4** Runs, metrics, cash flows, flags, risks, gate results; the persist function (one transaction, result hash, signature, audit event); latest views; append-only triggers.
- **P5** Decisions and artifacts.
- **P6** Hash-chained audit events and a verifier.
- **P7** RLS policies plus an adversarial suite: forged ids, cross-workspace access, revoked membership, signed-URL reuse.
- **P8** API skeleton: auth, per-request claims, errors, rate limits, OpenAPI and a generated typed client.
- **P9** API use cases: workspaces, deals, upload and finalize, assumption actions, readiness, idempotent runs, decisions, artifact requests, audit export.
- **P10** Worker: claim, lease, heartbeat, retry, dead-letter.

Exit: integration tests on a disposable database; RLS suite green; an API test takes typed assumptions to a signed, persisted run and reads it back identically.

### Phase 3: documents and extraction, pure parts parallel with Phase 1

- **X1** Upload verification job.
- **X2** Normalized document model and PDF text with positions.
- **X3** OCR fallback with confidence recorded.
- **X4** Spreadsheet, CSV, DOCX and text parsers with cell and line locations.
- **X5** Number tokenizer (`packages/numbers`).
- **X6** Candidate finders: line patterns (value-first, label-first), rent-roll and budget table readers with subtotal detection.
- **X7** Field mapping with unit compatibility and the output-like blocklist; every mapping records its rule.
- **X8** Conflicts, duplicate documents, supersession.
- **X9** Corpus scorer (precision, recall, F1 per field) as a gate with thresholds.

Exit: corpus thresholds met; Bergendal yields no silently wrong value; Dominion's three conflicts are named; Northgate blocks on its four missing inputs; Lantern Fields teaser figures never become inputs; Willowbrae duplicates do not double count; label-first lines extract.

### Phase 4: web app (`apps/web`), starts once the API contracts exist

- **W1** Shell, sign-in, workspace switcher, i18n, and the Ink & Signal tokens and components from the design template (see Design template below).
- **W2** Deals list and create deal.
- **W3** Documents step: upload, live status, retry, supersede.
- **W4** Review step: one summary line (approved, need review, missing, conflicting); items needing a decision first; missing and conflicting never hidden; second-approval queue.
- **W5** Run and results: one-line verdict, gate table, metrics with status labels, cash flows, stresses, flags, stale banner.
- **W6** Decision step.
- **W7** Reports step.
- **W8** Audit view.
- **W9** Seeding for the 3 demo packages.

Exit: Playwright walks all 3 demo deals end to end; accessibility scan passes.

### Phase 5: artifacts and audit package (`packages/artifacts`, worker)

- **A1** Memo and lender-package models built from the persisted run only.
- **A2** Formatting layer where every number carries its source reference; token scan as backstop; orphan number blocks the artifact.
- **A3** Renderers: PDF (HTML via Chromium), DOCX, Excel model export.
- **A4** Artifact storage with content hash and staleness.
- **A5** Audit package export with a validation block.

Exit: every reference deal that can run produces artifacts with zero orphan numbers, and screen, PDF, DOCX and Excel show identical figures.

### Phase 6: pilot readiness

- **L1** Release gate on a disposable environment: all migrations, all services, full acceptance suite, a signed release record (commit, migration version, engine and policy version, test results).
- **L2** Staging and production deploys; backups; restore drill.
- **L3** Alerts, runbook, on-call path.
- **L4** Security review; EICAR upload rejected; external pen test booked.
- **L5** Accessibility and performance budgets.
- **L6** People walk through all 15 reference deals on staging; V4 archived read-only.

## Sequencing

```
Phase 0 (spec, oracles, scaffold)          ~1-2 wks, bound by sign-offs
  |-- Phase 1 engine ---------------------- ~3-5 wks
  |-- Phase 2 platform -------------------- ~2-3 wks
  |-- Phase 3 extraction (pure parts) ----- ~3-4 wks
        Phase 4 web (after P8 contracts) -- ~3 wks
              Phase 5 artifacts (after P4, E11) ~2 wks
                    Phase 6 pilot readiness ~2 wks
```

Critical path: S2/S4 sign-off -> E1-E12 -> P4 -> W5 -> A1-A3 -> L1. Estimates only; phase exits, not dates, decide progress.

## Rules for agent-built work

1. One task, one PR, from a fresh branch off `main`, opened before the session ends; target under ~600 changed lines excluding fixtures.
2. Each task card names its spec sections, its acceptance tests and its gate tier. The failing test lands first in the PR history.
3. Oracles, policy and spec are protected by CODEOWNERS. A mismatch with an oracle is escalated to a person, never resolved by editing the oracle.
4. Engine and extraction agents work from the V2 spec and oracles, not V4 source. V4 is run only for the comparison report.
5. No test may assert on the text of source files, migrations or docs; no skipped tests in required tiers; gates run unpiped.
6. Any change that moves a number on a reference deal ships with the diff table and a human review.
7. Human review is mandatory for engine, policy, RLS, auth, upload handling and migrations.

## Verification

- Per phase: the exit criteria above, run by `pnpm gate --tier=pr` in CI.
- End to end: `pnpm gate --tier=release` on a disposable environment runs every unit, property, mutation, RLS, integration, corpus, oracle and Playwright suite; then the acceptance suite drives all 15 reference deals from raw documents to their expected outcomes (blocked with named reasons, conflicts named, verdicts and key metrics within tolerance, artifacts with zero orphan numbers); then every run on staging is replayed and must reproduce its stored result hash.
- Final human check: Chinonso and Anthony walk the 3 demo deals on staging and sign the release record.

## Design template: Ink & Signal

A brand-new look for V2; nothing is carried over from V4's steel blue and BC Sans. Canvas: https://claude.ai/artifact/LSM5FkLSvhwMir4KGtWZnt (private until shared from its Share menu).

**Idea.** Ink on paper, and colour only where it means something. The interface is neutral; the only saturated colours on screen are status.

**Tokens.**

| Group | Token | Value | Use |
|---|---|---|---|
| Neutral | paper | `#F4F2EC` | app ground |
| | surface | `#FDFCF9` | panels, tables |
| | sunken | `#ECE9E1` | formula wells, highlighted rows |
| | rule | `#DDD8CC` | hairlines, borders |
| | ink / ink-2 / ink-3 | `#15171C` / `#454A55` / `#626773` | text, primary action, labels |
| Pass | solid / text / tint | `#2350C8` / `#1B45B0` / `#E4EAF8` | Approve, approved input, passed check |
| Review | solid / text / tint | `#9A6212` / `#8A5A00` / `#F6ECD4` | With conditions, needs review, awaiting second approver |
| Stop | solid / text / tint | `#C8401F` / `#B3361A` / `#F8E3DC` | Reject, blocked, missing, conflicting, failed gate |
| Not measured | tint / text, dashed edge | `#E9E7E1` / `#4A4F5A` | Not evaluated, not applicable, not meaningful |

**Type.** Newsreader for sentences that matter (verdicts, titles, the memo); IBM Plex Sans for the interface; IBM Plex Mono with tabular figures for every number, right-aligned in tables. Labels are 12 px caps at +0.08em.

**Shape.** 4 px spacing base; hairline rules instead of boxes; radii 3 (tags), 4 (controls), 6 (panels); touch targets at least 44 px.

**Components drawn.** Verdict badge for all four codes; seven input-state tags; metric cell with status (never a zero for "not meaningful"); trace block (how a number was made); source chip (document, location, approver); blocking banner; five-step deal stepper (Documents, Review, Run, Decision, Reports); primary, secondary, quiet and disabled buttons.

**Screens drawn.** Deals list; 01 Documents (Rivergate: per-file checked, read, values found, OCR warning, retry); 02 Review (Dominion Exchange: the three documented conflicts, source preview, needs-review queue); 03 Run and results (Maple Heights: verdict, stored gate results, stresses, key figures, checks, trace, run record); IC memo page 1 on Letter. Figures come from the V4 Maple Heights fixture and the Dominion Exchange scenario; queue counts, file-level counts and bracketed items are placeholders.

**Rules implementers follow.**
1. Every status shows a glyph, a word and a colour; colour is never the only signal.
2. Missing and conflicting inputs are never collapsed or hidden.
3. A disabled action states why beside it, never only in a tooltip.
4. The UI reads the verdict and gate results from the stored run; it never recomputes them.
5. One answer per screen: a headline, supporting figures, then evidence behind a disclosure.

## Needs a person before or during execution

- Create the new repository and confirm its name; Supabase projects, OpenShip project, AV scanner, error sink accounts.
- Approve S1-S8; credit sign-off on S4 (thresholds, LTC ceiling) and on decisions 1, 2 and 8 with the Phase 1 diffs.
- Build or review the reference workbooks (O2).
- Approve the design template (S9) and share its canvas with Anthony.
- Book the external pen test.
