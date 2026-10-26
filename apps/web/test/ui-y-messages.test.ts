import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translateMessage } from "../src/i18n.tsx";

// The people and account functions (migrations 0031 and 0032) answer with these sentences, and the screens show them
// through ErrorText, so a French screen needs each one in French. The three from 0018 are among them: 0031 recreates fn_add_member.
const dir = join(import.meta.dirname, "../../../packages/db/migrations");
const sentences = [...new Set(["0031_people_and_account.sql", "0032_deal_details.sql"]
  .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/raise exception '((?:[^']|'')+)'/g)].map((m) => m[1]!.replace(/''/g, "'"))))]
  // A 401 sends the person to sign in; the sentence is never shown.
  .filter((s) => s !== "not signed in");

describe("the people and account answers, in French", () => {
  it("reads every sentence from the two migrations", () => {
    expect(sentences.length).toBeGreaterThanOrEqual(13);
    expect(sentences).toContain("The owner's role cannot be changed");
  });
  it.each(sentences)("translates: %s", (s) => {
    expect(translateMessage(s)).not.toBe(s);
  });
});
