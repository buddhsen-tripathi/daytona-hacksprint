// extraFields label match (issue #12): exact label first, then normalised; never fuzzy, never guessed.
//   pnpm --filter @311relay/worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchExtraField, normalizeLabel } from "../dist/adapters/common.js";
import { validatePayload } from "../dist/protocol.js";

test("normalizeLabel drops (optional)/(required), punctuation and case", () => {
  assert.equal(normalizeLabel("Car number (optional)"), "car number");
  assert.equal(normalizeLabel("Phone*:"), "phone");
  assert.equal(normalizeLabel("Tell us more (Required)"), "tell us more");
});

test("matchExtraField: exact, then normalised, else null", () => {
  const extra = { "Car number": "4211", "Phone (optional)": "212 555 0100" };
  assert.deepEqual(matchExtraField(extra, "Car number"), { key: "Car number", value: "4211" });
  assert.deepEqual(matchExtraField(extra, "Car Number (optional)"), { key: "Car number", value: "4211" });
  assert.deepEqual(matchExtraField(extra, "Phone"), { key: "Phone (optional)", value: "212 555 0100" });
  assert.equal(matchExtraField(extra, "Car"), null); // no fuzzy guesses
  assert.equal(matchExtraField(undefined, "Car number"), null);
  assert.equal(matchExtraField({ "Car number": "  " }, "Car number"), null);
});

test("protocol: form.extraFields must be Record<string,string> when present", () => {
  const base = {
    attemptId: "a", complaintId: "c", target: "real", category: "subway-delay", formUrl: "https://contact.mta.info/s/customer-feedback",
    allowedHosts: ["contact.mta.info"], extraHeaders: {}, cdpUrl: null, liveViewUrl: null,
    form: { description: "x", address: null, borough: null, latitude: null, longitude: null, contactName: null, contactEmail: null, contactPhone: null, dateObserved: null },
    limits: { totalTimeoutMs: 1, stepTimeoutMs: 1, maxNavigationRetries: 0 },
  };
  const bad = (p) => validatePayload(p).some((x) => x.includes("extraFields"));
  assert.equal(bad({ ...base, form: { ...base.form, extraFields: { "Car number": "4211" } } }), false);
  assert.equal(bad({ ...base, form: { ...base.form, extraFields: { "Car number": 4211 } } }), true);
});
