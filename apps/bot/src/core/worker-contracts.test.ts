import { describe, expect, it } from "vitest";
import { FilingErrorCode, FilingPayload, FormRecipe, formSchemaFromEvent, type WorkerEvent } from "./contracts.js";

// #9 additive worker contracts: automation / recipe on the payload, NO_ADAPTER, form_schema events.
describe("worker contracts (#9)", () => {
  const base = {
    attemptId: "a",
    complaintId: "c",
    approvedVersion: 1,
    target: "real",
    category: "subway-delay",
    formUrl: "https://contact.mta.info/s/customer-feedback",
    allowedHosts: ["contact.mta.info"],
    extraHeaders: {},
    cdpUrl: null,
    liveViewUrl: null,
    form: { description: "x", address: null, borough: null, latitude: null, longitude: null, contactName: null, contactEmail: null, contactPhone: null, dateObserved: null },
    limits: { totalTimeoutMs: 1, stepTimeoutMs: 1, maxNavigationRetries: 0 },
  };

  it("payload without automation/recipe still parses; with them too", () => {
    expect(FilingPayload.safeParse(base).success).toBe(true);
    const recipe = { id: "subway-delay", categoryId: "subway-delay", version: 1, steps: [{ open: { waitFor: "body" } }] };
    expect(FilingPayload.safeParse({ ...base, automation: "adapter:recipe", recipe }).success).toBe(true);
    expect(FilingPayload.safeParse({ ...base, automation: "submit-everything" }).success).toBe(false);
    expect(FormRecipe.safeParse({ ...recipe, steps: [] }).success).toBe(false);
  });

  it("NO_ADAPTER is a filing error code", () => {
    expect(FilingErrorCode.parse("NO_ADAPTER")).toBe("NO_ADAPTER");
  });

  it("formSchemaFromEvent", () => {
    const schema = { adapter: "handoff", category: "graffiti", url: "https://portal.311.nyc.gov/x", complete: true, steps: [{ name: "form", fields: [{ label: "Describe", type: "textarea", required: true }] }] };
    const e: WorkerEvent = { ts: "t", step: "inspect", level: "info", message: "form_schema", data: { schema } };
    expect(formSchemaFromEvent(e)).toEqual(schema);
    expect(formSchemaFromEvent({ ...e, message: "action" })).toBeNull();
    expect(formSchemaFromEvent({ ...e, data: { schema: { adapter: 1 } } })).toBeNull();
  });
});
