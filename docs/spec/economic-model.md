# Economic model (engine 1.0.0)

Implemented by `packages/engine/src/ledger.ts`; every metric is a projection of this ledger.

**Time.** Month `m` covers `[m, m+1)` from t0. Construction is `[0, C)`, lease-up `[C, S)` with
`S = C + L`, the hold `[S, S + 12H)`. The sale is at month `T = S + 12H - 1`.

**Costs.** Land at month 0. Hard, soft, contingency and other costs are spread over `[0, C)`,
straight-line or S-curve (smoothstep), allocated to the cent.

**Credits.** Other costs may be negative only when the figure is a genuine credit: its own label says
so (credit, rebate, refund, remise, remboursement and the like), or a person entered it with a written
reason. A negative figure that does not say it is a credit is refused, never read as one, and no sign
is ever flipped. The credit is spread over `[0, C)` with the other construction costs, so it lowers
cost in the months those costs are paid, never land at month 0. Land, hard, soft and contingency stay
at least 0. A credit is refused when total cost (land + hard + soft + contingency + other) would not
stay above 0, or when it exceeds hard + soft + contingency together, which would make a month's
construction spend negative. A cost stress scales positive other costs; a credit shrinks when costs fall
and is never enlarged by a cost overrun. A deal with no credit computes exactly as before. Artifacts show the
line as "Other costs (credit)" with its amount.

**Funding (decision 2).** Equity first, then mezzanine, then senior. Each tranche accrues interest
on its opening balance every month before `S`, capitalized while commitment remains; any
shortfall is paid by equity. Required equity is solved so the debt is exactly fully drawn at `S`.
Owner decision (2026-10-05): once the mezzanine commitment is used, mezzanine interest accrues on the
mezzanine balance (paid in kind), above its commitment. Equity does not pay it and the senior loan never
funds it; senior interest beyond the senior commitment is still paid by equity. The amount is the ledger's
`mezzAccruedBeyondCommitment` and the `mezz_interest_accrued` metric: it is `NOT_APPLICABLE` when there is no
mezzanine loan, and 0 is a real value when the loan never ran over. A warning check states it, and the lender
package and the memo repeat that sentence where the mezzanine loan is described. The mezzanine balance at
`S` (commitment plus accrued) is what amortizes, sizes coverage, counts in `total_debt` and is repaid at
sale; loan to cost stays on commitments. The invariant: at `S`, unused commitment is zero unless equity is
zero, and an equity overrun and unused commitment never coexist. The solve reports `converged` only when
`|overrun - unused| < 0.005` and `min(overrun, unused) < 0.005`, or equity is zero; otherwise
`funding_not_converged` is raised.
Total development cost = costs + interest before stabilization. A stated interest reserve is a
check, never an input.

**Revenue.** Per-unit: units x monthly rent x 12. Per-SF: area x annual rent per SF. Rents grow by
hold year. Component occupancy falls back to stabilized occupancy. Lease-up income only when the
deal opts in, ramping `(k + 0.5) / L`; fixed costs are due in full from the first operating month.

**Expenses (decision 8).** Fixed part grows at expense growth; variable part is a share of that
month's EGI. A single expense ratio is fixed dollars equal to that share of year-1 stabilized EGI.

**Debt.** No cash debt service before `S`. Interest-only until the later of the IO period and `S`,
then a level payment on the balance at that moment. A refinance at month `R >= S` retires the
senior balance; the new loan is sized by amount or by LTV on forward 12-month NOI at the exit cap.

**Coverage (decision 1).** Sizing debt service is the level amortizing payment on each tranche's
sized principal while it is in force. Sizing DSCR = weakest hold year of NOI / sizing debt
service; the gate reads it under combined stress. Contractual DSCR uses debt service actually due.

**Exit.** Exit value = final hold-year NOI / exit cap; not meaningful when NOI is not positive.
Non-recourse floor on the sale leg only.

**Equity flows.** Contributions dated when paid (`t = m/12`); operating cash per hold year at its
end; lease-up income at `S/12`; refinance at `R/12`; sale at `(T+1)/12`. IRR reports every root
(decision 3): one root is a value, none or several is "not meaningful".

**Stresses.** Six single shocks and a combined one, each a full re-run (policy v1).

**Checks.** Agreement checks compare stated figures with the model. Bound checks hold on every
deal: debt at or above total cost, LTC above the policy ceiling, a wiped-out sale leg, a stated
equity that does not cover the requirement. Any error-severity check rejects the deal.

**Verdict.** Five gates: equity multiple >= 1.5x, profit on cost >= 15%, spread >= 100 bps (base);
sizing DSCR >= 1.20x and equity multiple >= 1.0x (combined stress). An error check rejects; an
unmeasurable gate gives NOT_EVALUATED; more than two failures reject; one or two failures give
APPROVE_WITH_CONDITIONS.
