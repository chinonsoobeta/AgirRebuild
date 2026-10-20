# Card 97 audit report — 2026-10-19

Local branch: `task/97-audit-fixes`, from `main` at `673117c`. No network or push. No blind-deal or answer-key folders were opened.

## 97a–c verification checkpoint

| Part | Commit |
|---|---|
| 97a — Review proposals | `22c5237ade91feed2dd90cd46e8bbb469357d185` |
| 97b — Published-table provenance | `084688d2c4cc62dfbafac57688d753fb8c45d26a` |
| 97c — Rendering | `923eb01f52e123e1706a10cde10ac623625187c5` |

| Check | Result |
|---|---|
| `VITEST_MAX_WORKERS=2 npm run gate -- --tier=pr` | Both typechecks passed; 1,738 tests passed in 15 files |
| `VITEST_MAX_WORKERS=1 npx vitest run apps/api/test/api.test.ts` | Whole file: 196 passed |
| `npx tsc -b` after 97c | Passed; `git checkout -- tsconfig.tsbuildinfo` restored the tracked cache |
| Artifact and web rendering tests | 149 passed |

97d (`c82891a98b5a8b6682e83c14e98e3ad3e11bf6f9`) records these checks and removes trailing whitespace from four approved text-pin lines. It changes no behaviour and adds no test infrastructure.

## Approved report-text pins

The owner approved these seven new pins after the initial stop. Each new text is exactly the old text with whole-word DSCR→DCR. Numeric tokens are unchanged. Each repinned test records its old hash in a comment. Stored engine/result labels and the six rental reference pins were not edited.

| Fixture | Report | Old text SHA-256 | Approved text SHA-256 |
|---|---|---|---|
| held | ic_memo | `29531862e11b0510111895565f213a8c2d4975d8f2fe79d694e646e4f056f404` | `22e94946039c8786f9a8793faf7c7d1686ed3bae5b8b7977ea14a4c79c7df731` |
| held | build_decision | `d605a268e8b161c97f6b79a3855f06c93aa3bc3f9a7b0e283b8671c0c8a4b98f` | `61757e6912b7e04bbcee1c3fe37927271b3da4409678b6d8446d535771888a08` |
| held | lender_package | `4cf6ef2277600502cf073624101fc3988664370849ef77e986513ebe66afb08a` | `a0cc7a283f1ce22d258878b616a500a5eaafc457f2cc6169abb023d08d0e609b` |
| Maple Heights | ic_memo | `fa9dd2f818ca58ba1500ec30db01d5171229546e8828b96d74e9f0138bf93812` | `200c7159ce649a03fff64ef222399b755da85112d8fce957b0f6df3ea69ff7c4` |
| Maple Heights | build_decision | `64389bea70bedfb6f257617d58cc54d1bfff3bf08f55eb90e2f967f1d91736d0` | `161df3ae41c30a1322c47bf6b2cb6d4b4b7c18b34de0dbc177b2e819aca70fd9` |
| Maple Heights | lender_package | `5f81e68b930e8735a4036eba356bad6242bc1e05cdaa3ca89a84a69f47dd208c` | `be3357a81416eb58bb60c7147850071e584947e517fa7b5e77e3f44bd5cf9641` |
| Maple Heights, warning omitted | build_decision | `c49c28c5eafee7e5d6eb89704d4b04584c7887ecbf5d51bd33160417cf83d17e` | `3377dc48bc5130ccc4b8941ac7ccb38f612e8c939d1ac8a431cb7476c8ef29ae` |

## source_kind review

Every match from `git grep -n source_kind -- packages/db/migrations apps packages` was inspected. The current search has 86 matches in 14 files. The line lists below identify every occurrence; handling applies to all listed occurrences in that file. Historical migrations were not modified.

| File and current lines | Handling |
|---|---|
| `apps/api/src/services.ts`: 62, 89, 104, 109, 110, 271, 348, 404 | Extended the source-kind union; sponsor-stated remains analyst-only. Table metadata produces source labels, is saved in run snapshots, and identifies approved table rows for nonblocking recomputation notices. Default and document label paths remain unchanged. |
| `apps/api/test/api.test.ts`: 291, 735, 736, 780, 1076, 1077, 1355, 1604, 1624, 1656, 1688, 1793, 1832, 1877, 1947, 1969, 1988, 1998, 2969, 2970 | Preserved all existing analyst/document/default expectations. Added table acceptance, source snapshot, solo/team approval, tampering, copy and changed-input notice assertions. |
| `apps/worker/src/index.ts`: 222, 246, 301, 361, 382, 398, 419, 447, 452, 460 | Added a distinct settled-value label for table values. Reconciliation continues to treat table rows as settled non-document values: agreeing documents add evidence; disagreement reopens a conflict; removing a document does not discard a table value. Existing source-kind comparisons and restore paths are unchanged. |
| `packages/db/migrations/0001_schema.sql`: 126 | Historical migration unchanged. Migration 0022 replaces its check constraint to allow table. |
| `packages/db/migrations/0002_functions.sql`: 255, 259, 308, 319, 337, 340 | Historical migration unchanged. Manual entry/default/review statements retain analyst/default semantics; the 0022 trigger clears source_table whenever the source kind becomes non-table. |
| `packages/db/migrations/0006_solo_review.sql`: 11, 74, 78, 102, 103, 135, 146 | Historical migration unchanged. agir_sponsor_stated remains analyst-only. Its governed entry function is mirrored by fn_enter_table_value in 0022. Manual entry stays analyst; existing review/reopen semantics are retained. |
| `packages/db/migrations/0007_agir_review.sql`: 110, 114, 138, 139 | Historical migration unchanged. Manual review modifications still become analyst; 0022 clears obsolete table metadata on that transition. A reopen that retains table kind also retains its table snapshot. |
| `packages/db/migrations/0010_figure_labels.sql`: 124, 128, 152, 153 | Historical migration unchanged. Manual modifications and source-based reopening retain their existing behaviour; the 0022 trigger clears metadata if kind changes away from table. |
| `packages/db/migrations/0011_solo_use_as_stated.sql`: 57, 61, 95, 96 | Historical migration unchanged. Choosing/modifying a value manually remains analyst; the 0022 trigger clears table metadata on that transition. Existing table kind is retained on a reopen without a source replacement. |
| `packages/db/migrations/0012_deal_variants.sql`: 55, 57 | Historical migration unchanged. Migration 0022 replaces fn_copy_deal with the same implementation plus source_table in the copied assumption columns and values. |
| `packages/db/migrations/0014_decisions_stand.sql`: 2, 28, 35, 38, 71, 75, 109, 110 | Historical migration unchanged. The current review function still classifies hand changes as analyst and retains document-only source-removal handling. The 0022 trigger clears table metadata on a manual change. |
| `packages/db/migrations/0018_deal_clients.sql`: 182 | Historical migration unchanged. Existing value/status/source-kind changes still clear client confirmation. Table values are not sponsor-stated and cannot obtain sponsor client-confirmation status. The assumptions hash is extended in 0022 for table provenance only. |
| `packages/db/migrations/0022_table_values.sql`: 2, 3, 9, 30, 35, 46, 102, 104, 128 | Allows table kind, adds nullable source_table, mirrors entry permissions/audit/team approval, clears metadata on non-table transitions, preserves table metadata in copies, and adds provenance to assumptions hashes only for table rows. Previously approved table rows may be replaced through the server-recomputed stale-option acceptance path; prior second approvals are cleared. |
| `packages/db/test/db.test.ts`: 68, 77 | Existing direct document-fixture inserts are unchanged; the new constraint still permits them. The full database test file passed in the PR gate. |

CamelCase consumers were also updated: web API assumption/run-input types, Review and Run source rendering, artifact input types and input rows, and the Excel summary. A shared bilingual source label uses the accepted source snapshot. Human-entered source/reason text is not subjected to DSCR renaming.

Table-source storage: `source_table` is nullable text containing a JSON snapshot of `tableId`, `optionKey`, publisher, title, effective date, and prerequisite field keys. The accepting user is read from the governed row. The acceptance API accepts identifiers only and recomputes value/reason on the server. Table rows do not count as sponsor-stated or in that summary’s material-input denominator.

## 97e reading changes and final verification

Added 30 independently worded cases in the existing extraction test file, covering English/French commitment headings, construction scope preservation, label-stated duration units, the requested Canadian cost names, three Canadian currency forms, lender covenants, EGI percentages, and refusal of unrelated percentage bases. Before implementation, 22 of the 30 new cases failed; the existing 610 cases passed.

The fixes reuse the existing reader and field catalogue:

- An unlocated table inherits the document's loan scope only when the line headings establish one unambiguous scope. A located table keeps its positional scope.
- A comma-delimited months/years qualifier supplies the duration unit; the field name before it identifies the input, so construction timing words do not become hard costs.
- Added the missing cost/commitment/covenant aliases; retained the requested aliases already present.
- Debt coverage covenant wording bypasses the generic lender-limit refusal. A stated EGI basis supplies variable_expense_pct when no more specific compatible field was named.
- The existing tokenizer already reads CAD and CA$ prefixes. Its suffix expression now also consumes the complete $ CAD marker and preserves the currency code.

| Final check | Result |
|---|---|
| `VITEST_MAX_WORKERS=1 npx vitest run packages/extraction/test/extraction.test.ts` | 640 passed |
| `VITEST_MAX_WORKERS=2 npm run gate -- --tier=pr` | Both typechecks passed; 1,768 tests passed in 15 files |
| `VITEST_MAX_WORKERS=1 npx vitest run apps/api/test/api.test.ts` | Whole file: 196 passed |
| `git diff --check` | Passed |

All engine/result and reference-deal pin assertions passed without repinning. The six rental reference-deal pins and stored result labels were not changed. The only changed report-text hashes are the seven explicitly approved above. No blind-set score is claimed; Claude's independent rescoring remains to be done.

One intermediate gate failed because test formatting accidentally added spaces inside ten newly added numeric fixtures. Those strings were restored before the successful final gate; no production rule or existing expectation was changed to accommodate that failure.

## Human-review points and limitations

- The owner approved the supplied English/French source wording. Migration `0022_table_values.sql` still needs human review.
- Replacing an approved table value is allowed only through the server-recomputed current option; team material changes await a distinct second approver and clear old second approval.
- Existing manual entry through `/values`, `agir_sponsor_stated`, and non-table assumption hashes retain their prior behaviour.
- Narrow Review layout is checked with the permitted CSS assertion, not a live 597 px browser measurement.
- The workspace-switch regression uses the real `useDeal` hook with mocked session/query/effect execution.
- No remaining implementation question is open. Blind-set rescoring and human migration review remain outside this local verification.

## Post-audit corrections — 2026-10-19

The owner's four corrections supersede the broad EGI fallback, the water/wastewater alias, and the longer published-table source wording described above.

- EGI percentages now require a cost label: management/fee/variable labels map to variable_expense_pct; total/operating-expense labels map to expense_ratio_pct. An EGI basis alone does not choose either field. Regression cases cover the supplied total-expense, management-fee and vacancy examples plus English/French variants.
- Removed only water and wastewater charges from development_charges. Operating-budget water charges are not read as development charges; capital cost charges still are.
- Word cause: the parser retained the complete Heading 1, Title, and bold paragraph text. The existing scope reader already assigned rate and amortization to refinance fields. The missing candidate was “Interest-only period: none.”: the reader expected a numeric token and emitted nothing for none. It now passes explicit none through the existing scoped mapper as zero months, accepting only IO fields. No parser or alias workaround was needed. Each Word case also combines its candidates with a separate construction term sheet and checks for no conflicts and no senior fields from the take-out document.
- Updated source labels to the exact shorter English/French wording, with no added final stop or title. The conditional prerequisite labels are unchanged. Conflict-side wording is Published table / Tableau publié. The table title remains in the saved reason and source snapshot, covered in the acceptance test.

Verification: whole extraction file (`VITEST_MAX_WORKERS=1 npx vitest run packages/extraction/test/extraction.test.ts`) passed 655 tests. PR gate (`VITEST_MAX_WORKERS=2 npm run gate -- --tier=pr`) passed both typechecks and 1,784 tests across 15 files, including the whole API file. `git diff --check` passed. No engine/result or reference-deal pins were changed. No network, push, migration, dependency, or service was added for these corrections.
