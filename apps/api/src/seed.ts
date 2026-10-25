// Demo data for local development: two people, one workspace, and the six
// reference deals uploaded as real files through the same path the UI uses.
// Refuses to run in production.

import { asUser, type BlobStore, type Db } from "@agir/db";
import { drain } from "@agir/worker";
import { documentBytes, loadOracles } from "@agir/testkit";
import { kindOf } from "@agir/extraction";
import { hashPassword } from "./auth.ts";
import { createRun } from "./services.ts";

export const DEMO = {
  analyst: { email: "demo@agir.local", name: "Dana Analyst", password: "agir-demo-password" },
  approver: { email: "reviewer@agir.local", name: "Rowan Reviewer", password: "agir-demo-password" },
};

export async function seedDemo(db: Db, store: BlobStore, log = (m: string) => console.log(m)) {
  if ((process.env.AGIR_ENV ?? "development") === "production") throw new Error("The demo seed never runs in production.");
  const [existing] = await db.query(`select 1 from users where email = $1`, [DEMO.analyst.email]);
  if (existing) {
    log("Demo data already present.");
    return;
  }
  const mk = async (u: { email: string; name: string; password: string }) =>
    (await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $2, $3) returning id`, [u.email, u.name, await hashPassword(u.password)]))[0]!.id;
  const analyst = await mk(DEMO.analyst);
  await mk(DEMO.approver);
  const [{ id: ws }] = (await asUser(db, analyst, (tx) => tx.query<{ id: string }>(`select fn_create_workspace('Northbank Development Partners') as id`))) as [{ id: string }];
  await asUser(db, analyst, (tx) => tx.query(`select fn_add_member($1, $2, 'admin')`, [ws, DEMO.approver.email]));

  // The oracle files do not state a currency, so the demo states one from each
  // deal's location. Bergendal, in Stockholm, is left without one: its reports
  // say so rather than print its figures as dollars of a guessed kind.
  const place: Record<string, [currency: string | null, country: string | null, province: string | null]> = {
    "maple-heights": ["CAD", "CA", "BC"],
    "cascade-row": ["CAD", "CA", "BC"],
    "dominion-exchange": ["CAD", "CA", "AB"],
    "lantern-fields": ["USD", "US", null],
    "northgate-cold-storage": ["USD", "US", null],
  };
  const deals = new Map<string, string>();
  for (const deal of loadOracles()) {
    const [currency, country, province] = place[deal.slug] ?? [null, null, null];
    const [{ id }] = (await asUser(db, analyst, (tx) =>
      tx.query<{ id: string }>(`select fn_create_deal($1, $2, $3, $4, $5, $6, $7) as id`, [ws, deal.name, deal.assetType, deal.location, currency, country, province]),
    )) as [{ id: string }];
    deals.set(deal.slug, id);
    for (const doc of deal.documents) {
      const bytes = await documentBytes(doc);
      const put = await store.put(bytes);
      await asUser(db, analyst, (tx) =>
        tx.query(`select * from fn_register_document($1, $2, $3, $4, $5, $6)`, [id, doc.name, kindOf(doc.name), bytes.byteLength, put.sha256, put.key]),
      );
    }
    log(`Seeded ${deal.name} (${deal.documents.length} documents)`);
  }
  const jobs = await drain({ db, store });
  log(`Processed ${jobs} jobs`);

  // Three deals are reviewed and run so every step of the product has something to show.
  for (const slug of ["maple-heights", "cascade-row", "lantern-fields"]) {
    const dealId = deals.get(slug)!;
    await asUser(db, analyst, async (tx) => {
      const rows = await tx.query<{ id: string; version: number }>(`select id, version from assumptions where deal_id = $1 and status = 'needs_review'`, [dealId]);
      for (const r of rows) await tx.query(`select fn_review($1, 'approve', null, null, $2)`, [r.id, r.version]);
    });
    await asUser(db, analyst, (tx) => createRun(tx, dealId, new Date().toISOString().slice(0,10)));
    log(`Reviewed and ran ${slug}`);
  }
  const [{ id: runId }] = (await db.query<{ id: string }>(`select id from latest_runs where deal_id = $1`, [deals.get("maple-heights")])) as [{ id: string }];
  await asUser(db, analyst, (tx) => tx.query(`select fn_request_artifact($1, 'ic_memo', 'pdf')`, [runId]));
  await drain({ db, store });
  log("Rendered the Maple Heights IC memo");
}
