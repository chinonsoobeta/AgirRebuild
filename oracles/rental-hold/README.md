# Rental-hold reference deals

Fireweed Fourplex and Harbour Lane were built from the specification by a builder with no access to Agir’s code, recomputed independently, and hand-checked and signed by the owner on 2026-10-24.

The outcome JSON files are byte-for-byte copies of the signed workbook exports. They are inputs to verification, never adjusted to match the engine. Fireweed Fourplex uses `rental-hold-draft`; Harbour Lane uses `rental-hold-insured-draft` with MLI Select at 70 points.

Fireweed uses `leaseup_income_credited` and `cost_curve: "straight-line"`. Harbour Lane uses `lease_up_ramp` and has no `cost_curve` key: its draws are S-curve. Unit rents use `units_<n>bed` and `rent_<n>bed_monthly` for n in 1, 2 and 3, present only when used.

Tamarack Six (Red Deer, conventional, `rental-hold-draft`) is the approval case: the owner asked for a passing rental deal as a separate workbook. Its inputs were set by the reviewer to pass; a separate builder with no access to Agir's code, the other workbooks or the reviewer's calculation built it from the specification and the owner's settled readings. The hand check was done on 2026-10-24 by Claude on the owner's instruction, recomputing all eight items independently. It uses `cost_spread: "straight-line"` and `refinance_insurance_premium_pct: "not stated"` (no premium).
