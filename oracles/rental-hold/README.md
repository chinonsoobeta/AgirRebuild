# Rental-hold reference deals

The workbooks were built from the specification by a builder with no access to Agir’s code, recomputed independently, and hand-checked and signed by the owner on 2026-10-24.

The two outcome JSON files are byte-for-byte copies of the signed workbook exports. They are inputs to verification, never adjusted to match the engine. Fireweed Fourplex uses `rental-hold-draft`; Harbour Lane uses `rental-hold-insured-draft` with MLI Select at 70 points.

Fireweed uses `leaseup_income_credited` and `cost_curve: "straight-line"`. Harbour Lane uses `lease_up_ramp` and has no `cost_curve` key: its draws are S-curve. Unit rents use `units_<n>bed` and `rent_<n>bed_monthly` for n in 1, 2 and 3, present only when used.
