# ADR 0001: The local build's stack

Status: accepted for the first local build; revisit before deployment.

The plan named Supabase (Postgres, Auth, Storage) on OpenShip. The first build keeps the
architecture and changes three pieces so it runs on one laptop with no services:

| Plan | This build | Why, and the path back |
|---|---|---|
| Supabase Postgres | PGlite (embedded Postgres) when `DATABASE_URL` is unset; node-postgres when set | Same SQL, roles, RLS and functions. Set `DATABASE_URL` to use Supabase or any Postgres; run the worker as its own process (`apps/worker/src/main.ts`). |
| Supabase Auth | Email and password in the API: scrypt hashes, hashed session tokens, HttpOnly cookies, a CSRF header | Keeps the database-side identity model (`agir.user_id` per transaction). Swapping in Supabase JWTs changes only `userForSession`. |
| Supabase Storage | Content-addressed files under `.data/blobs` behind a `BlobStore` interface | An object-store implementation needs `put` and `get`. |
| pnpm + Turborepo | npm workspaces | pnpm was not installed; nothing depends on it. |
| Tailwind + shadcn/ui | Plain CSS with the Ink & Signal tokens | Fewer dependencies; the design is small and exact. |

Not built yet, and said so in the product: OCR (a scanned PDF with no text layer is marked
"could not be read" with a plain explanation) and market data.

Virus scanning is out of scope for now (decided 2026-09-24). Uploads are checked structurally:
the file type matches its content, the size and SHA-256 fingerprint match what was uploaded,
and a text file is valid UTF-8. A scanner can be added later as one step in the worker's
verify job.
