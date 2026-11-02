# Engine mutation testing

Stryker 10.1.1 with the vitest runner, over `packages/engine/src/**/*.ts`: 4,536 mutants. Config: `stryker.config.json` and `packages/engine/vitest.mutation.config.ts`. Mutation testing is not part of the gate. Run it on engine changes, one process at a time, after checking `sysctl vm.swapusage` and `memory_pressure -Q`:

```
npm run mutation
```

The run is incremental: it reuses `reports/mutation/incremental.json` where code and covering tests are unchanged. Delete that file for a clean run, which takes hours. Reports are in `reports/mutation/` and are not committed.

**Bar.** `thresholds.break` in `stryker.config.json` is 92, about two points under the final score of 94.27, so a real loss of test strength fails the run and ordinary drift does not.

**Scale.** In these runs the property rules ran at a tenth of their cases (`BEHAVIOUR_RUNS_SCALE=0.1`) with a 180 s limit per test, so that one run stays within hours. The baseline had neither, and had none of the property rules. A kill that needs a rare generated case could be missed at this scale, so the scores lean low rather than high.

## Scores

Score is (killed + timeout) / all mutants, runtime errors left out. Cells are score, then survived and no coverage in brackets.

| File | Baseline | First final run | Last run |
|---|---:|---:|---:|
| canonical | 77.78 (7, 1) | 100.00 (0, 0) | 100.00 (0, 0) |
| checks | 73.86 (77, 9) | 86.32 (39, 6) | 95.74 (8, 6) |
| explore | 82.07 (57, 28) | 82.07 (57, 28) | 94.09 (26, 2) |
| forsale | 83.61 (53, 7) | 87.43 (39, 7) | 89.62 (31, 7) |
| irr | 63.06 (39, 2) | 71.17 (30, 2) | 76.58 (24, 2) |
| ledger | 83.68 (106, 2) | 87.35 (84, 1) | 89.00 (73, 1) |
| math | 74.51 (19, 7) | 98.04 (2, 0) | 99.02 (1, 0) |
| metrics | 71.71 (76, 51) | 89.76 (44, 2) | 96.88 (12, 2) |
| readiness | 80.80 (156, 26) | 91.24 (83, 0) | 95.25 (45, 0) |
| stress | 92.24 (9, 0) | 98.28 (2, 0) | 98.28 (2, 0) |
| underwrite | 69.77 (21, 5) | 90.70 (8, 0) | 91.86 (7, 0) |
| validate | 67.30 (139, 32) | 99.24 (4, 0) | 99.81 (1, 0) |
| verdict | 87.71 (28, 1) | 97.88 (5, 0) | 98.31 (4, 0) |
| waterfall | 81.94 (13, 0) | 93.06 (5, 0) | 93.06 (5, 0) |
| **All** | **78.52** (800, 171) | **90.09** (402, 46) | **94.27** (239, 20) |

The last run took 87 minutes: 4,241 killed, 21 timeouts, 15 runtime errors.

After it, five readiness tests were added and one corrected, aimed at readiness 135:76, 145, 195, 220:84, 228:44 and 349:65. Those kills are not counted in the table.

The hash pins (`sale-explore-pins.json`, the for-sale hash pins) hold engine output, so some kills show a change and not that the output is right. Stryker stops at the first kill, so their share is not known.

## What is left, by reason

Every remaining Survived or NoCoverage mutant is in a group below. "Equivalent" means no input gives a different result.

### Equivalent

**irr**
- 8: flipping the sign of every flow gives the same roots.
- 14, 17, 25: bisection stops on an interval under 1e-12 long before 200 iterations; a sign change always brackets a root, and the exit after the loop is never reached.
- 34-37: zero flows add nothing to NPV; with flows of one sign, NPV never crosses zero, so the early return only saves time.
- 39: a stray entry in the grid gives NaN at the first comparison and is skipped.
- 40-42: the grid accumulates in floats, so r is never exactly -0.5, 1 or 10 at those comparisons (the last value is 9.999999999999831).
- 46: reading past the grid gives undefined, then NaN, which is skipped.
- 51 (`isFinite`): at r above -0.5 and t under about 40 years, NPV is finite. 51:101 (`prevV !== 0`): twin of the exact-zero test on the previous step, which has already added that root; the dedupe at 59 removes it.
- 59 (`<=` to `<`): needs two roots exactly 1e-6 apart in floats. Roots closer and further are tested.

**math, stress, underwrite, validate, verdict, waterfall**
- math:23: when values tie, a comparator that is always positive keeps the original order, which is what the tie-break does.
- stress:20: with `other` of 0, multiplying by anything gives 0. stress:42: the validator ties `exit: for_sale` and `forSale` together.
- underwrite:24: a validated input throws nothing else inside that call. underwrite:38, 40; verdict:11, 54; metrics:10: `m()` gives a null value unless the status is VALID, so reading status or value alone agrees.
- validate:10: `Number.isFinite` already refuses anything that is not a number.
- waterfall:27: a negative flow treated as a distribution gets the same split and raises the hurdle by the same amount. waterfall:41: only adds a zero row.

**checks**
- 25, 29: a premium above 0 needs a refinance, and every tier has its ceiling; `undefined` comparisons are false.
- 88: accrued interest above 0 needs a mezzanine above 0.

**metrics**
- 23: an empty status falls to NOT_MEANINGFUL inside `m()`.
- 69: a null profit gives a null ratio anyway. 83, 83 NoCoverage: debt in place always gives a debt yield.
- 118: gross rent of 0 makes the ratio Unknown either way.
- 126, 127: zero amounts add nothing. 161: guarded by a premium, which needs a refinance. 194: `m()` again.
- 207: a refinance falls before the sale, so its window has at least a month.

**forsale**
- 58: floor of 0 sales at n = 0. 70, 74: with construction above 0, month 0 interest is zero, so the branch adds nothing.
- 79, 90, 126: flows are already in date order, and a comparator of the wrong sign leaves V8's order unchanged for ascending input. 123: negating every date's total gives the same number of sign changes.
- 140: line 174 overrides it. 142, 175: the validator requires a unit.
- 150: one sign change has at most one root, and no root gives NaN, which is Unknown.
- 151: a string in an array has no key. 153: zero flows add nothing; and a contribution total of NaN and a positive one take the same branch, while no contributions leave nothing to map.
- 155, 163, 174: `""` as status falls to NOT_MEANINGFUL in `m()`.
- 114: needs a reconciliation of exactly 0.01 in floats. 199: comparing with undefined is false.

**ledger**
- 116, 118, 143, 144, 307-309: spreading a zero amount, or a zero-length lease-up, adds zero.
- 152, 169: `interestByTranche` is returned by the simulation but nothing reads it.
- 175-185, 196, 203, 214-221: solver transients. At the fixed point there is no shortfall and no unused budget, and the outer solve finds the same equity.
- 246, 247, 260, 262: array length and initial values are overwritten; 200 iterations are not reached by a converging solve.
- 265: float boundary (`<` to `<=` at 0.005) and the second clause. Senior exhausted implies mezzanine exhausted, so overrun and unused commitment cannot both remain. That guard looks unreachable.
- 270 (`equityBudget === 0`): when the next budget is 0 and this one is not, the following pass reaches the same point and stops there.
- 331: the validator forces a refinance on a held deal. 375: a forward NOI of 0 gives value 0 both ways. 404: twin of the guard at 333, which throws first.
- 431, 463: 0 either way. 443, 450: `NaN` and past-the-end rows are not read by what follows.
- 479, 485: needs exactly 0.005 in floats.

**explore**
- 84, 152, 331: `m()` gives null unless VALID.
- 89, 99, 100: label of a scenario that is built, read for its metrics and dropped.
- 118, 119: a shock moves the refinance by exactly the timeline's shift, so month + shift is already within S and T-1 and neither clamp binds.
- 237: first = 0 returned on the line above. 263, 265: a validated line has one basis or the other.
- 288, 290: `underwrite`, called next, validates the same input and throws the same error; the exploration has no other refused input.
- 300, 301: only error-severity checks are read, and the covenant check that uses this figure is never an error.

**readiness**
- 36, 37: `undefined` comparisons are false.
- 87, 89: a rejected row is not readable anyway; the fallback array is replaced.
- 181: with either figure absent the item is already missing, so no input is built.
- 242, 246: no field with a `required` other than false has `absentMeans`.
- 249: every key in `missing` is a real field. 359: `assemble` throws nothing else there.

### Unreachable by any known input

- checks:85-86, forsale:188, ledger:260 (`funding_not_converged`): the solve converged on everything tried. Left as a guard.
- readiness:49-58: rows of the problem-to-field table that name `unit_sale_price`, `unit_count`, the presale shares, sales pace, closing lag and carry. Field bounds in the contract (`pct` 0-100, absorption at least 0.01, lag 0-60, carry and price at least 0) refuse the value first, so `validateInput`'s sentence never arrives through `assemble`, and the person is still sent to the field by the bounds check. These rows are dead.

### Only wording differs

- readiness:49-61, the `^` removed from each pattern: none of these phrases appears mid-sentence in another problem.
- explore:341, 342: `limit > 0` to `>= 0` changes "-0" to "+0" when a driver has no reach at all.
- ledger:288: the text of an error `underwrite` catches and turns into a check with its own message.

## Known failure and silences

- `test.fails` in `behaviour.test.ts`: a rental with no build shows no cost or equity on its monthly rows, while its flows show the contribution. The sale ledger places them at month 0. ledger:437, 438 (`m < S`) survive because of this; `m < S` to true is arguably the fix.
- A for-sale delay can raise the multiple while profit falls, when mezzanine interest paid in kind replaces equity. Rule 3 is held to profit on cost for that case only. See the comment at rule 3.
- The specification is silent on a refinance value when forward NOI is not positive (the code uses 0), and on sub-cent differences between rounded monthly allocations and unrounded costs.
