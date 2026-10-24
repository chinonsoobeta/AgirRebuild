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
Total development cost = costs + operating costs during lease-up + interest before stabilization.
A stated interest reserve is a check, never an input.

**Revenue.** Per-unit: units x monthly rent x 12. Per-SF: area x annual rent per SF. Rents grow by
hold year. Component occupancy falls back to stabilized occupancy. Lease-up income only when the
deal opts in, ramping `(k + 0.5) / L`; fixed costs are due in full from the first operating month.

**Operating costs during lease-up (cards 39 and 40, owner approval 2026-10-05).** From the first month
after construction ends until `S`, the deal pays its fixed operating costs every month, whether or not the
ramp is on. Fixed costs are `fixed_opex_annual`, or the fixed-dollar expense-ratio amount of decision 8,
exactly as year 1 computes them, at year-1 levels, divided by 12. Variable costs follow income, so with the
ramp off there are none before `S`. With the ramp off, these months are a cost before `S`: they are funded
like any other cost (equity first, then mezzanine, then senior), they are part of total development cost, and
they are shown as their own line, "Operating costs during lease-up", in sources and uses. With the ramp on,
nothing changes: the fixed costs were already netted against lease-up income, and that net is paid at `S`
(the `lease-up income` flow), so ramp-on deals compute byte for byte as before. Costs before `S` never appear
in hold-year cash flows, and year-1 operations and the hold years are unchanged. The metric
`leaseup_operating_cost` is the amount charged to total development cost this way; it is `NOT_APPLICABLE`
when lease-up is 0 months or when the ramp is on (the costs are then netted in the lease-up flow, not added to
total development cost), and 0 is a real value only when fixed costs are 0. The `total_development_cost` and
`hard_and_soft_cost` formula texts are unchanged: hard and soft cost is still land, hard, soft, contingency and
other costs, and the lease-up cost is its own line beside capitalized interest.

**Cash shortfall and interest-only coverage.** `cumulative_cash_shortfall` is the sum, over the hold, of the
negative monthly cash flow after debt service (NOI less debt service), as a positive amount. It is the cash a
developer must find while the deal runs at a deficit after `S`; months before `S` are excluded because they are
funded in total development cost. 0 is a real value when there is never a deficit. `io_dscr_year1` is year-1
NOI divided by the interest-only debt service on the debt in force at `S` (senior plus mezzanine balances times
their rates); it is `NOT_APPLICABLE` with no debt and is a secondary metric, not a gate.

**Expenses (decision 8).** Fixed part grows at expense growth; variable part is a share of that
month's EGI. A single expense ratio is fixed dollars equal to that share of year-1 stabilized EGI.

**Debt.** No cash debt service before `S`. Interest-only until the later of the IO period and `S`,
then a level payment on the balance at that moment. A refinance at month `R >= S` retires the
senior balance; the new loan is sized by amount or by LTV on forward 12-month NOI at the exit cap.

**Coverage (decision 1).** Sizing debt service is the level amortizing payment on each tranche's
sized principal while it is in force. Sizing DSCR = weakest hold year of NOI / sizing debt
service; the gate reads it under combined stress. Contractual DSCR uses debt service actually due.
Owner decision 2026-10-17 (card 72): a held deal's senior loan uses its monthly interest-only payment
for sizing until refinance when `senior.ioMonths >= refinance.month`. This is the held-deal rule itself,
not a policy option. Senior amortization is then optional and omitted from the input when not stated.
If an amortizing cash or sizing payment needs missing senior amortization, the run returns an error check
and REJECT without computing payment figures. Sale deals, mezzanine and refinance-loan sizing, and cash
debt service are unchanged.
Zero debt service retains the existing null-coverage convention.

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

## Exit by refinancing and holding

Card 60, owner decision 2026-10-15: show both. A small rental builder usually builds, refinances and keeps
the building, so that deal is judged on what it returns at the refinance and on the debt it carries, and
also, labelled as unrealized, on a stated value. Draft: the policy for it needs credit sign-off.

**The flag.** The field `refinance_and_hold` ("Keep and refinance (no sale)", unit flag, 0 or 1) is a modelling
choice made in review, never read from a document. When it is 1, readiness sets `EngineInput.exit` to
`"refinance_hold"`. When it is absent or 0 the key is omitted, so every sale deal's input hash is unchanged.
In hold mode a refinance is required: with no refinance month the run is blocked and the problem points at
`refinance_month`: "A deal that is kept and refinanced needs its refinance: the month, the amount or
loan-to-value, the rate and the amortization." The refinance rules are otherwise the existing ones: the month
falls from `S` to before `T`; an amount or a loan-to-value, not both; rate and amortization required.

**What does not change.** Everything up to `T` is the same ledger: costs, funding, equity, operations, debt
service, the refinance and the stresses. Hold mode changes only the end of the hold.

**No sale leg.** `saleNet` is 0, there is no `sale` equity flow, and the non-recourse floor of the sale does not
apply.

**Stated value.** Final hold-year NOI / exit cap, with no selling costs. It is not meaningful when that NOI is
not positive. It is a stated value, not a sale price: nothing is sold.

**Unrealized flow.** One equity flow of the new kind `unrealized`, dated `(T + 1)/12`, equal to the stated
value less all debt outstanding at `T` (senior and mezzanine balances), floored at 0. It is the only flow of that
kind, and wherever flows are shown it is labelled "unrealized, not a sale". When the stated value is not
meaningful there is no such flow. When the stated value does not cover the debt, the flow is 0 and the
equity-wipeout check (an error) fires with its own message: "The stated value of X does not cover the Y of
debt outstanding. Equity has no value at the end of the hold."

**Contributions and distributions.** As for a sale: contributions are the negative equity flows, distributions
the positive ones, so operating, refinance and unrealized flows all count in the multiple.

**Hold metrics.** Appended to the metric catalog after the existing metrics, in this order, and computed in hold
mode only. On a sale deal they are not added to the result at all, so a sale deal's result is byte for byte what
it was before this section.

| Key | Definition |
|---|---|
| `refinance_cash_returned` | New loan less the senior payoff at the refinance. Negative means cash was put in. |
| `cash_left_in_deal` | Equity contributed to fund the deal (required equity) less cash returned at the refinance. 0 or below means all of the equity came back. Operating cash before the refinance is not counted as returned (open for the owner). |
| `dcr_after_refinance` | NOI over the 12 months from the refinance month / the amortizing (sizing) debt service on all debt in force in those months. |
| `cash_on_cash_after_refinance` | (NOI less the debt service actually due) over the 12 months from the refinance month / cash left in the deal. Not meaningful, with that reason, when cash left in the deal is 0 or below. |
| `stated_value` | The stated value above. |
| `unrealized_equity_multiple` | (operating + refinance + unrealized distributions) / contributions. |
| `unrealized_equity_irr` | IRR of the dated flows including the unrealized flow. The roots rule of decision 3 applies: one root is a value, none or several is not meaningful. |

**The 12 months from the refinance month** are months `R` to `R + 11`. If fewer than 12 months remain (the hold
ends at `T`, so months `R` to `T` are available), the months that remain are used and scaled to a year (NOI and
debt service each times 12 / months used), and the metric's reason says so.

**Sale metrics in hold mode** are `NOT_APPLICABLE` with the reason "The deal is kept and refinanced, not sold.":
`exit_value`, `net_sale_proceeds`, `development_profit`, `profit_on_cost`, `equity_multiple`, `equity_irr`,
`sale_month`, `lp_irr`, `gp_irr` and `gp_promote`. Never 0.
Every other metric is computed as today from the same ledger.

**Partners of a held deal.** Owner decision 2026-10-19 (card 87): a held deal with an LP/GP split has a partner
memo. It runs the existing waterfall over the run's stored equity flows twice: with the unrealized flow, giving each
partner's distributions, multiple and IRR and the GP promote, all labelled unrealized, not a sale; and without it
(by kind, since the last operating flow shares its date), giving the cash paid out so far, with no IRR. These are
report arithmetic over the run's flows with the engine's `runWaterfall` and `irrRoots`, not engine metrics, so no
run result changes; an IRR follows the roots rule of decision 3. Base case only: the stored flows are the base
scenario's.

**Stresses.** The same six single shocks and the combined one, each a full re-run in hold mode. An exit-cap shock
moves both the refinance loan, when it is sized by loan-to-value, and the stated value.

**Policy.** `POLICY_V1` is unchanged, so its hash and the freshness of every existing run are unchanged. A
registry maps each policy version to its policy; every sale deal uses `policy-v1`. Held deals use one of two
drafts (consolidation, owner decision 2026-10-18): `rental-hold-insured-draft` when a stated refinance
insurance premium is above zero, with a DCR-after-refinance floor and a base-case sizing warning floor of
1.10x, and `rental-hold-draft` otherwise (conventional), with 1.20x for both. A signed policy is frozen; a
draft is edited in place until credit signs it. Every run stores the policy it ran under in its input
snapshot. Replay, the sensitivity routes and the worker use that stored copy, and replay checks that its
hash is the run's `policy_hash`. A run whose draft has since been edited is stale ("The policy thresholds
changed after this run."), never unreplayable. Both drafts take v1's stresses, loan-to-cost ceiling,
tolerance and source precedence, and have four gates. The thresholds are proposals for credit, not decisions:

| Gate or warning | Scenario | Threshold |
|---|---|---|
| development spread | base | >= 100 bps |
| coverage after refinance (`dcr_after_refinance`) | base | >= 1.10x insured; >= 1.20x conventional |
| base-case sizing warning (not a gate) | base | below 1.10x insured; below 1.20x conventional |
| sizing DSCR (senior IO through refinance when eligible) | combined | >= 1.20x |
| unrealized equity multiple | combined | >= 1.0x |

The verdict rules are v1's: an error check rejects; an unmeasurable gate gives NOT_EVALUATED; more than two
failures reject; one or two give APPROVE_WITH_CONDITIONS. A run records the policy, its version and hash it was made
under, is fresh against the current hash of that version, and replays under its stored policy. Beside the verdict, the run screen and every
artifact say "Draft policy, not signed by credit". A decision can still be recorded, and it names the policy
version.

## Canadian cost lines and mortgage insurance

**Card 94 — draft insured products (owner review required).** A positive premium and at least 50 stated MLI Select points selects the Select draft: post-refinance DCR gate and base sizing floor 1.10x. Otherwise the insured product is Standard: 5–6 units use 1.20x; 7+ units use 1.20x for a term of at least 10 years, or 1.30x for a shorter term. Readiness requires the term for 7+ Standard units. CMHC multi-unit insurance needs at least five units; 2–4-unit lender terms stay entered by a person.

| Product | Minimum points | Maximum LTV | Max loan-to-cost (new construction) | Maximum amortization |
|---|---|---|---|---|
| Standard | — | 85% | 100% | 40 years |
| Select | 50 | 85% | 95% | 40 years |
| Select | 70 | 95% | 95% | 45 years |
| Select | 100 | 95% | 95% | 50 years |

Sources, read 2026-10-19: [CMHC MLI Select](https://www.cmhc-schl.gc.ca/professionals/project-funding-and-mortgage-financing/mortgage-loan-insurance/multi-unit-insurance/mliselect) and [Standard Rental Housing](https://assets.cmhc-schl.gc.ca/sf/project/cmhc/pdfs/content/en/standard-rental-housing.pdf). The highest qualifying points tier applies. LTV uses the loan **before** capitalized premium. **Owner decision 7 (2026-10-23, card 151):** the stricter of CMHC's two columns. The refinance loan before premium must fit both the tier's existing-property maximum LTV against the refinance value and its new-construction maximum loan-to-cost against total development cost (`refinance_ltc_limit`). Amortization uses the existing-property limits. The policies stay drafts until credit signs. Limits reside in the stored policy; older insured runs become stale and replay under their stored policy. `policy-v1` is unchanged.


Card 61. A small Canadian builder's budget has lines Agir could not name, and the CMHC-insured take-out loan
that keeps most rentals alive carries an insurance premium that is added to the loan. This section adds them as
values a person enters. Cited tables propose values for explicit acceptance in Review; no value is applied silently. Review offers the premium only once a refinance month is stated.

**Reading (card 61b).** Development charges and land transfer tax are read from documents (`extractable: true`), into
their own fields and no longer under other costs. Their aliases moved from `other_cost` ("development charges",
"development cost charges", "DCCs", "DCs", "land transfer tax", "LTT", "taxe de bienvenue", "droits de mutation"), and
"dcc", "redevance de developpement" and "welcome tax" were added. A document line then meets the value a person
entered: an agreeing figure adds the document as a source, a disagreeing one reopens the entry as a named conflict,
and the cost is counted once. When the label names both a longer and a shorter alias ("land transfer duty" and
"land"), the longer one reads the figure. Two land transfer tax lines in one document (provincial and municipal) are
a named conflict, not a sum, as two other-cost lines are; a person enters the total. When absent, these two appear
under "Not found in the documents", not "Choices only you make". A deal read before this card proposes
`development_charges` and no `other_cost` at its next reconcile, so the "source removed" rule applies to the old
other-cost row and the new value waits for review.

**Reading and verification (card 125).** GST/HST net and yearly property tax are also read from documents
(`extractable: true`) and appear under "Not found in the documents" when absent. Every document-sourced value
carries a verification note and requires individual review, outside "Approve all". GST/HST is read only as a tax
balance net of rebates; the person must check the rebates this project qualifies for. Property tax is added to fixed
operating costs or the expense ratio, so the person must check it is not already included there. Explicitly included
amounts and property-tax parts of a stated operating-cost table total stay shown. A monthly property-tax amount
is multiplied by twelve. A value typed by the person carries no verification note. The refinance premium stays
unread (`extractable: false`) under "Choices only you make": it is a lender's term chosen with the refinance,
not a budget line.

**The fields.** All are optional, 0 or more, and in dollars unless stated. Each is set on the engine input only
when it has a value; an absent field is omitted, never `0` and never `undefined`, so a deal that states none of
them has the input, the ledger and the result it had before this section, byte for byte.

| Field | Engine input | Absent means |
|---|---|---|
| `development_charges` | `budget.developmentCharges` | none stated |
| `land_transfer_tax` | `budget.landTransferTax` | none stated |
| `gst_hst_net` (GST/HST net of the rental rebates) | `budget.gstHstNet` | none stated |
| `property_tax_annual` | `propertyTaxAnnual` | included in operating costs, or none |
| `refinance_insurance_premium_pct` (0 to 10) | `refinance.insurancePremiumPct` | no mortgage insurance |

The premium needs `refinance_month`, like the other refinance terms: stated without a refinance it is not put on
the input (as `refinance_io_months` is not), and review offers it only when a refinance month is stated. If a
cost line already sits in soft or other costs, or property tax in the expense ratio or fixed operating costs, the
person leaves it out; each field's help line says so.

**Timing.** Development charges and land transfer tax are paid at month 0, with land. GST/HST net is paid in the
last construction month, `C - 1`, or at month 0 when `C` is 0. All three are funded as any cost before `S` is:
equity first, then mezzanine, then senior.

**Totals.** The three lines are part of costs before financing and of total development cost, as "other" costs
with their own timing. No formula text changes: "other" includes these named lines. Interest on the debt that
funds them is capitalized as for any cost, so total development cost rises by their sum plus that interest.

**Property tax** is a fixed operating cost, added to the fixed part of decision 8 on top of
`fixed_opex_annual`, or on top of the expense ratio's fixed dollars. It grows at expense growth, is charged in
the lease-up months like the other fixed costs (cards 39 and 40), and counts in year-1 operating expenses and in
break-even occupancy through the fixed costs. The expense stress moves the expense ratio or the variable share
and so does not move it.

**Stresses.** The cost stress scales the three cost lines like every other positive cost.

**The insurance premium** is capitalized into the refinance loan. The refinance loan amount is the stated amount,
or the loan-to-value share of forward value; the loan-to-value sizes the loan before the premium. The premium
added is that amount times the premium percent, and the balance at the refinance is the amount times
`(1 + premium %)`. Debt service, sizing debt service, `dcr_after_refinance` (card 60) and the debt outstanding at
`T` all use the balance with the premium. The cash returned at the refinance, and `refinance_net_proceeds`, is the
loan amount less the payoff of the senior balance: the premium is not cash. With a premium stated and a refinance
made, the metric `refinance_premium_added` (the premium added to the loan, in dollars) is reported beside
`refinance_net_proceeds`; with no premium stated it is not added to the result at all, so every other result is
byte for byte what it was.

**Checks.** An agreement check that compares a stated total cost already uses total development cost, so it
includes the new lines. No check is added.

**Outputs.** Sources and uses shows each cost line by name, only when it is stated. The lender package says, beside
the debt terms, "Mortgage insurance premium: X% (Y added to the loan)" when a premium is stated. The operating
statement shows property tax as its own fixed line when it is stated. The quick start asks for development
charges and property tax per year in both templates, with 0 allowed so the person states it rather than a default
applying, and the apartment template also asks, as optional questions, for land transfer tax and GST/HST net.

**Open for the owner.** When development charges are paid (permit or occupancy) and whether some are deferred;
whether the cost stress should scale them; whether a premium on an insured construction loan is needed now (not
in this card); and the cited tables that will replace entered values.

## Selling the units (townhomes and small condos)

**Status: specified, not built.** Owner decisions 2026-10-15 (the model) and 2026-10-18 (rules Q1 to Q5 below).
The reference workbooks `kestrel-row-townhomes.xlsx` (8 townhomes, Ontario, 50% presold) and
`alder-court-condo.xlsx` (30-unit condo, BC, 70% presold, 4-month closing lag) implement this section; they become
oracles once a person completes each workbook's "Hand check" sheet. No engine code is written before that.

**Mode.** A flag `sell_units` ("Sell the units (no rental)") sets `exit = "for_sale"`. It excludes
`refinance_and_hold`; both together block the run. Rent, occupancy, expense, growth, exit cap, selling cost,
lease-up and refinance fields are out of use; if any is stated the run is blocked with a named problem.
Equity, total cost, loan to cost and interest reserve stated for a sale are checked against the model as for a rental deal
(interest reserve against interest during construction); the DSCR covenant is rental-only.

**Inputs** (entered by a person, no defaults): `unit_count` and `unit_sale_price` per unit type, the price net
of GST/HST and any rebate the builder keeps; `presold_units_pct`; `deposit_pct`; `absorption_units_per_month`;
`sales_commission_pct`; `closing_lag_months` (0 for a freehold townhome); `unsold_carry_monthly` per unit;
optionally `senior_presale_threshold_pct`.

**Time and costs.** Construction is `[0, C)`; completion is month `C`. Costs and funding before `C` are as for
a rental deal. After `C` there is no operating income: interest on every tranche is capitalized with no
commitment limit ("interest after completion"), and carry is paid by equity as a contribution.

**Sales and closings.**
- *Q3, presold units:* `floor(total units × presold_units_pct / 100)`. They all close at `C + closing_lag_months`.
- *Q4, absorption:* the remaining units start selling in month `C`; cumulative units sold by the end of month
  `C + k` = `min(unsold, floor(absorption_units_per_month × (k + 1) + 1e-9))`, and each month's sales are the
  difference from the month before. Units stay whole when the rate is fractional.
- A unit sold in month `s` closes in month `s + closing_lag_months`. `E`, the sell-out month, is the last closing.
- *Q2, price:* every closing is priced at the deal's average price (gross sales revenue ÷ total units), so the
  order in which unit types sell does not matter. Net proceeds = units closing × average price × (1 − commission).
  They repay senior (with its capitalized interest), then mezzanine; the rest goes to equity.
- *Q1, carry:* each month, `unsold_carry_monthly × units completed and not yet closed at the start of the month`,
  presold units waiting to close included.
- Deposits are held in trust and never fund costs (decision 1). They change no cash flow and are reported only,
  as `deposits_held_at_completion` = presold units × average price × deposit %.

**Lender's presale condition.** When `senior_presale_threshold_pct` is stated and `presold_units_pct` is below it,
an error check fires ("The construction loan needs X% presold; Y% is stated.") and the verdict is REJECT.
*Q5:* the condition is tested on base inputs only; in a stress, lower presales change timing and add no error.

**Equity flows.** Contributions are dated `m / 12`, distributions from closings in month `m` at `(m + 1) / 12`.
IRR follows the roots rule (decision 3): exactly one sign change gives a value, otherwise "not meaningful".
Carry paid after the first closings can give several sign changes; this is a property of the deal, and IRR is
not a gate. Equity multiple = distributions ÷ contributions. Peak equity = the largest cumulative contributions
less distributions.

**Metrics** (for-sale mode only, so rental results are unchanged byte for byte): `gross_sales_revenue`,
`net_sales_revenue`, `interest_after_completion`, `carry_total`, `development_profit_for_sale` (net sales
revenue − total development cost − carry − interest after completion), `profit_on_cost_for_sale` (profit ÷
(total development cost + carry + interest after completion)), `margin_on_revenue` (profit ÷ net sales
revenue), `peak_equity`, `sellout_month`, `deposits_held_at_completion`, `equity_multiple`, `equity_irr`.
NOI, rent, occupancy, coverage, exit value, development spread, yield on cost and break-even occupancy are
`NOT_APPLICABLE` ("The units are sold; there is no rental income."), never 0.
With an LP/GP split stated, `lp_irr`, `gp_irr` and `gp_promote` come from the same two-tier waterfall over the sale’s dated equity flows, and each partner IRR follows the sale’s rule for `equity_irr` (one sign change and one root, otherwise `NOT_MEANINGFUL`); without one they are `NOT_APPLICABLE` as before.

**Stresses**, each a full re-run with debt commitments unchanged: prices −10%; absorption × 0.70; land, hard,
soft and contingency +10%; rates +1 point; construction +6 months; presales −15 points (not below 0); and all
six combined.

**Policy.** `for-sale-draft`, labelled "Draft policy, not signed by credit", editable until credit signs (like
the held drafts). Gates: profit on cost ≥ 15% (base); margin on revenue ≥ 12% (base); profit on cost ≥ 0%
(combined); equity multiple ≥ 1.0x (combined). The verdict rules are v1's: an error rejects; any gate that
cannot be measured makes the verdict NOT_EVALUATED; more than two failures reject; one or two give
APPROVE_WITH_CONDITIONS.

Construction cost placement and the equity solve are shared by the rental and for-sale ledgers. With `S = C`, both checked reference deals agree with the workbooks within their stated tolerances; the engine retains its existing half-cent convergence criterion rather than the workbook's fixed 30 iterations.
