import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandoffAdapter } from "../src/adapters/handoff.js";
import { matchFieldByLabel } from "../src/adapters/fields.js";
import { resolveAdapter } from "../src/adapters/registry.js";
import { HAS_CHROME, runAdapter, serveFixtures } from "./harness.js";
import { testPayload } from "./helpers.js";

describe("hand-off: registry + label matching", () => {
  it("automation handoff resolves to the hand-off adapter for any catalog category", () => {
    const r = resolveAdapter(testPayload({ category: "abandoned-vehicle", automation: "handoff" }));
    expect(r.ok && r.adapterId).toBe("handoff");
    expect(r.ok && r.create().id).toBe("handoff");
  });

  it("matchFieldByLabel: exact, contains, ambiguous ⇒ null", () => {
    const fields = [{ label: "Describe the problem (required)" }, { label: "Floor number" }, { label: "Apartment number" }];
    expect(matchFieldByLabel("describe the problem", fields)?.label).toBe("Describe the problem (required)");
    expect(matchFieldByLabel("Floor", fields)?.label).toBe("Floor number");
    expect(matchFieldByLabel("number", fields)).toBeNull();
    expect(matchFieldByLabel("", fields)).toBeNull();
  });
});

describe.skipIf(!HAS_CHROME)("hand-off adapter against static HTML (local Chrome)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => ({ server, base } = await serveFixtures()));
  afterAll(() => server?.close());

  const payloadFor = (page: string, extraFields?: Record<string, string>) =>
    testPayload({
      category: "abandoned-vehicle",
      automation: "handoff",
      formUrl: `${base}/${page}`,
      allowedHosts: ["127.0.0.1"],
      liveViewUrl: "https://live.example/session",
      form: { contactEmail: null, ...(extraFields ? { extraFields } : {}) },
    });

  it("prefills only extraFields by label, never submits, ends HUMAN_ACTION_REQUIRED with the live view", async () => {
    const r = await runAdapter(createHandoffAdapter(), payloadFor("handoff-form.html", { "Describe the problem": "Car with no plates for 3 weeks", "building type": "Apartment", "Shoe size": "9" }));
    try {
      expect(r.outcome.status).toBe("HUMAN_ACTION_REQUIRED");
      expect("errorCode" in r.outcome && r.outcome.errorCode).toBeNull();
      expect("data" in r.outcome && r.outcome.data).toMatchObject({ handoff: true, liveViewUrl: "https://live.example/session", prefilled: ["Describe the problem (required)", "Building type"], notMatched: ["Shoe size"] });
      expect(r.submitClicked).toBe(false);
      const page = r.session.page;
      expect(await page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
      expect(await page.inputValue("#desc")).toBe("Car with no plates for 3 weeks");
      expect(await page.inputValue("#btype")).toBe("apt");
      // contactEmail is null ⇒ the email field is never touched.
      expect(await page.inputValue("#email")).toBe("");
      expect(r.actions).toEqual([
        { kind: "fill", target: "Describe the problem (required)", chars: 30 },
        { kind: "fill", target: "Building type", chars: 9 },
        { kind: "stop", target: "handoff" },
      ]);
      // PII-free log: the typed text never appears in an event.
      expect(JSON.stringify(r.events)).not.toContain("no plates");
      const schema = r.events.find((e) => e.message === "form_schema")?.data?.schema as { adapter: string; complete: boolean; url: string; steps: { name: string; fields: unknown[] }[] };
      expect(schema).toMatchObject({ adapter: "handoff", category: "abandoned-vehicle", complete: true, url: `${base}/handoff-form.html` });
      expect(schema.steps[0]!.fields).toEqual([
        { label: "Describe the problem (required)", type: "textarea", required: true },
        { label: "Building type", type: "select", required: false, options: ["Choose…", "Apartment", "House"] },
        { label: "Floor number", type: "text", required: false },
        { label: "Email", type: "email", required: false },
        { label: "Password", type: "text", required: false },
      ]);
    } finally {
      await r.session.release();
    }
  });

  it("CAPTCHA detected ⇒ HUMAN_ACTION_REQUIRED/CAPTCHA, nothing filled, no submit", async () => {
    const r = await runAdapter(createHandoffAdapter(), payloadFor("handoff-captcha.html", { "Describe the problem": "x" }));
    try {
      expect(r.outcome.status).toBe("HUMAN_ACTION_REQUIRED");
      expect("errorCode" in r.outcome && r.outcome.errorCode).toBe("CAPTCHA");
      expect("data" in r.outcome && r.outcome.data?.liveViewUrl).toBe("https://live.example/session");
      expect(r.actions).toEqual([]);
      expect(r.submitClicked).toBe(false);
      expect(await r.session.page.inputValue("#desc")).toBe("");
      expect(await r.session.page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
    } finally {
      await r.session.release();
    }
  });

  it("login wall ⇒ HUMAN_ACTION_REQUIRED/LOGIN_REQUIRED", async () => {
    const r = await runAdapter(createHandoffAdapter(), payloadFor("handoff-login.html"));
    try {
      expect([r.outcome.status, "errorCode" in r.outcome && r.outcome.errorCode]).toEqual(["HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED"]);
    } finally {
      await r.session.release();
    }
  });
});
