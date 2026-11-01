# Engine mutation testing

**Status: the final run has not happened.** The baseline below is real. The score after the new tests is unknown, because swap was over the 1,800 MB limit set for starting a Stryker run (2,131 MB of 3,072 MB on 2026-11-01). Rerun with the command below and fill in the "after" column.

## What ran

- Tool: Stryker 10.1.1 with the vitest runner, over `packages/engine/src/**/*.ts`. Config: `stryker.config.json` and `packages/engine/vitest.mutation.config.ts`.
- Baseline: started 2026-10-31 20:30 PDT, took 203m43s, 4,536 mutants. It ran on the 359 engine tests that existed before `behaviour.test.ts` and `mutation-gaps.test.ts`.
- Rerun, one process at a time, after checking `sysctl vm.swapusage`:

```
bash /Users/chinonsoobeta/agir-v2/.worktrees/heavy.sh npm run mutation
```

The run is incremental: it reuses `reports/mutation/incremental.json` where code and covering tests are unchanged. Delete that file for a clean run. Reports are in `reports/mutation/` and are not committed. Mutation testing is not part of the gate.

## Scores per file

| File | Mutants | Killed | Survived | Timeout | No coverage | Baseline score | After |
|---|---|---:|---:|---:|---:|---:|---|
| canonical | 36 | 28 | 7 | 0 | 1 | 77.8 | not run |
| checks | 329 | 243 | 77 | 0 | 9 | 73.9 | not run |
| explore | 488 | 384 | 57 | 5 | 28 | 82.1 | not run |
| forsale | 366 | 304 | 53 | 2 | 7 | 83.6 | not run |
| irr | 111 | 67 | 39 | 3 | 2 | 63.1 | not run |
| ledger | 674 | 555 | 106 | 9 | 2 | 83.9 | not run |
| math | 102 | 75 | 19 | 1 | 7 | 74.5 | not run |
| metrics | 449 | 322 | 76 | 0 | 51 | 71.7 | not run |
| readiness | 948 | 766 | 156 | 0 | 26 | 80.8 | not run |
| stress | 116 | 107 | 9 | 0 | 0 | 92.2 | not run |
| underwrite | 86 | 60 | 21 | 0 | 5 | 69.8 | not run |
| validate | 523 | 352 | 139 | 0 | 32 | 67.3 | not run |
| verdict | 236 | 207 | 28 | 0 | 1 | 87.7 | not run |
| waterfall | 72 | 59 | 13 | 0 | 0 | 81.9 | not run |
| **All** | **4,536** | **3,529** | **800** | **20** | **171** | **78.52** | not run |

16 mutants ended in a runtime error (14 in explore, 2 in ledger) and are not in the score.

The baseline overstates what was proven in one respect. `sale-explore-pins.json` and the for-sale hash pins hold engine output, so they kill mutants without showing the output is right. Stryker stops at the first kill, so the share of kills owed to them is not known.

## Surviving mutants, from the baseline

These groups come from reading the code. None has been confirmed by a rerun, so "should die" below is an expectation.

### Equivalent: no input can tell them apart

- irr:8 sign flip gives the same roots. irr:34-37: no sign change has no roots anyway. Bisection tolerances and irr:14, 17, 25 cannot be reached. irr:51 finiteness.
- ledger:169 `interestByTranche` is never read. ledger:175-185, 214-221: solver transients, because at the fixed point there is no shortfall. ledger:116, 118, 143, 246, 247, 307-309, 398, 443, 450, 463. ledger:333 and 404 are twin guards. ledger:331: the validator already forces a refinance.
- stress:20 (0 times x), stress:42. forsale:35, 58, 90, 150, 162, 175, 199. verdict:11, 54: `m()` guarantees a null value unless valid. metrics:83, 88, 118. waterfall:41: only a zero-amount flow differs.
- readiness: the `mezz_amort_years` fallback of 30 on a rental cannot be reached, because that field is required once a mezzanine exists.

### False survivors

Four mutants are marked survived with 0 tests completed, from worker crashes: ledger:144, math:29, validate:122, stress:14.

### Not derivable at reasonable cost

- ledger:260, forsale:188 and checks:85 (`funding_not_converged`): no known input reaches them.
- explore: not worked through. Breakeven and tornado survivors need numbers from a solver, and those were not derived by hand. 57 survived, 28 no coverage.

### Worth a person's look

- readiness:49-61, the problem-to-field table: only `unit_count` and `input` are pinned here. A wrong field sends a person to the wrong line.
- ledger:437, 438 (`m < S`): see the known failure below. These may die only by making the `test.fails` pass.

### Should die in the rerun

The new tests target math, irr, canonical, waterfall, stress, funding and refinance arithmetic, metric edges, checks, verdict words, every validate branch, for-sale rows and readiness rules. Error-message mutants were given lowest priority.

## Known failure and silences

- `test.fails` in `behaviour.test.ts`: a rental with no build shows no cost or equity on its monthly rows, while its flows show the contribution. The sale ledger places them at month 0.
- A for-sale delay can raise the multiple while profit falls, when mezzanine interest paid in kind replaces equity. Rule 3 is held to profit on cost for that case only. See the comment at rule 3.
- The specification is silent on a refinance value when forward NOI is not positive (the code uses 0), and on sub-cent differences between rounded monthly allocations and unrounded costs.

## Recommended bar

Do not set a final bar until the rerun gives real numbers. Then set `thresholds.break` about two points under the final overall score, so a real loss of test strength fails and ordinary drift does not. Keep it out of the gate and run it on engine changes, because a clean run takes hours. Until then, the only defensible floor is the baseline: 78.
