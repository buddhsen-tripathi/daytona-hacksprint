/**
 * The MTA subway-delay flow as a recipe (fixtures/recipes/subway-delay.json) must take the same actions as the
 * hand-written reference adapter on a dry run. Both run against a local mock of the wizard (test/fixtures/mta-wizard.html)
 * in local Chrome; neither may click "Submit your feedback".
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMtaSubwayDelayAdapter } from "../src/adapters/mta-subway-delay.js";
import { createRecipeAdapter, validateRecipe, type FormRecipe } from "../src/adapters/recipe.js";
import { resolveAdapter } from "../src/adapters/registry.js";
import type { TransitDetails } from "../src/protocol.js";
import { HAS_CHROME, runAdapter, serveFixtures } from "./harness.js";
import { testPayload } from "./helpers.js";

const recipe = JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/recipes/subway-delay.json"), "utf8")) as FormRecipe;

describe("subway-delay recipe fixture", () => {
  it("is a valid recipe and resolves through the registry as adapter:recipe", () => {
    expect(validateRecipe(recipe)).toEqual([]);
    const r = resolveAdapter(testPayload({ automation: "adapter:recipe", recipe }));
    expect(r.ok && r.adapterId).toBe("recipe:subway-delay");
    expect(resolveAdapter(testPayload({ category: "abandoned-vehicle", automation: "adapter:recipe", recipe })).ok).toBe(false);
    expect(resolveAdapter(testPayload({ automation: "adapter:recipe" })).ok).toBe(false);
  });
});

describe.skipIf(!HAS_CHROME)("recipe ≡ hand-written MTA adapter on the dry run (local mock wizard, local Chrome)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => ({ server, base } = await serveFixtures()));
  afterAll(() => server?.close());

  const transit = (over: Partial<TransitDetails> = {}): TransitDetails => ({ line: "A", direction: "downtown", station: "14 St", borough: "Manhattan", incidentTime: null, delayMinutes: 20, ...over });
  const payload = (t: TransitDetails, contact: { name?: string | null; email?: string | null } = {}) =>
    testPayload({
      formUrl: `${base}/mta-wizard.html`,
      allowedHosts: ["127.0.0.1"],
      realSubmitAuthorized: false,
      form: { description: "A train held at 14 St for 20 minutes with no announcements.", transit: t, contactName: contact.name ?? null, contactEmail: contact.email ?? null },
    });

  async function both(p: ReturnType<typeof payload>) {
    const hand = await runAdapter(createMtaSubwayDelayAdapter(), p);
    const handSubmitted = await hand.session.page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);
    await hand.session.release();
    const rec = await runAdapter(createRecipeAdapter(recipe), p);
    const recSubmitted = await rec.session.page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);
    await rec.session.release();
    return { hand, rec, handSubmitted, recSubmitted };
  }

  it("line + direction + station + contact: identical actions, both stop before Submit", async () => {
    const { hand, rec, handSubmitted, recSubmitted } = await both(payload(transit(), { name: "Ada Lovelace", email: "ada@example.com" }));
    expect(hand.outcome).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: null });
    expect(rec.outcome).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: null });
    expect(rec.actions).toEqual(hand.actions);
    expect(hand.actions).toEqual([
      { kind: "click", target: "Get started" },
      { kind: "choose", target: "Subways" },
      { kind: "continue", target: "Continue" },
      { kind: "choose", target: "Complaint or issue" },
      { kind: "continue", target: "Continue" },
      { kind: "choose", target: "Service and schedule" },
      { kind: "continue", target: "Continue" },
      { kind: "choose", target: "Delay" },
      { kind: "continue", target: "Continue" },
      { kind: "choose", target: "A Line" },
      { kind: "continue", target: "Continue" },
      { kind: "choose", target: "A Train-Downtown & Queens" },
      { kind: "continue", target: "Continue" },
      { kind: "pick", target: "14 St" },
      { kind: "continue", target: "Continue" },
      { kind: "continue", target: "Continue" },
      { kind: "fill", target: "Tell us more (Required)", chars: 59 },
      { kind: "continue", target: "Continue" },
      { kind: "fill", target: "First name (optional)", chars: 3 },
      { kind: "fill", target: "Last name (optional)", chars: 8 },
      { kind: "fill", target: "Email (optional)", chars: 15 },
      { kind: "stop", target: "Submit your feedback" },
    ]);
    expect([hand.submitClicked, rec.submitClicked, handSubmitted, recSubmitted]).toEqual([false, false, false, false]);
    // form_schema: inspect (partial) + validate (complete) from both; never a typed value.
    for (const r of [hand, rec]) {
      const schemas = r.events.filter((e) => e.message === "form_schema").map((e) => e.data!.schema as { complete: boolean; steps: { name: string; fields: { label: string; type: string }[] }[] });
      expect(schemas.map((s) => s.complete)).toEqual([false, true]);
      const full = JSON.stringify(schemas[1]);
      expect(full).toContain("A Train-Downtown & Queens");
      expect(full).toContain("Tell us more (Required)");
      expect(full).toContain("Email (optional)");
      expect(full).not.toContain("ada@example.com");
      expect(full).not.toContain("no announcements");
    }
  });

  it("no station, no contact, unmatched direction with questions disabled: identical hand-off", async () => {
    // "Brooklyn-bound" matches neither A option ⇒ both ask; questionTimeoutMs 0 ⇒ the fallback hand-off.
    const { hand, rec } = await both(payload(transit({ station: null, direction: "Brooklyn-bound" })));
    expect(hand.outcome).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: "UNEXPECTED_REQUIRED_FIELD" });
    expect(rec.outcome).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: "UNEXPECTED_REQUIRED_FIELD" });
    expect(rec.actions).toEqual(hand.actions);
    expect(rec.questions.map((q) => [q.id, q.options])).toEqual(hand.questions.map((q) => [q.id, q.options]));
  });

  it("unmatched direction answered live + no station: identical actions", async () => {
    const answers = { direction: { value: "Uptown (Inwood-207 St)", optionIndex: 0 } };
    const p = payload(transit({ station: null, direction: "Brooklyn-bound" }));
    const hand = await runAdapter(createMtaSubwayDelayAdapter(), p, answers);
    await hand.session.release();
    const rec = await runAdapter(createRecipeAdapter(recipe), p, answers);
    await rec.session.release();
    expect(rec.outcome).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: null });
    expect(rec.actions).toEqual(hand.actions);
    expect(rec.actions).toContainEqual({ kind: "choose", target: "A Train-Uptown (Inwood-207 St)" });
    expect(rec.actions).toContainEqual({ kind: "skip", target: "station" });
  });
});
