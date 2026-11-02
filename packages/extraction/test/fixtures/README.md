Invented scanned pages for tests. Each is one page of the same made-up budget, drawn in Liberation Sans and stored as a single image: `scan-jbig2.pdf` as JBIG2 (MMR-coded), `scan-jpx.pdf` as JPEG 2000.

The Card 198 fixtures (`formula-results.xlsx`, `formula-recalc.xlsx`, `dates.xlsx`, `formula-zero.xlsx`, and `typed-zero.xlsx`) are invented workbooks written as raw XML so that every saved-result form is exact. Their makers are not part of the repo.

`zip64-local.xlsx` (Card 200) is an invented workbook whose local headers carry a zip64 field, written with Python's `force_zip64` because JSZip cannot write one.
