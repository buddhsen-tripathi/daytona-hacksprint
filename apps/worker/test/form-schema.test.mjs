// Unit tests for the generic form-schema capture (issue #11). Runs against the compiled worker (dist/), so build first:
//   pnpm --filter @311relay/worker test   (builds, then `node --test`)
// The browser test needs a local Chrome/Chromium (CHROME_PATH, or the usual macOS/Linux paths) and skips cleanly without one.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { captureFormSchema, controlsToFields, mergeFormStep } from "../dist/adapters/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
  (p) => p && existsSync(p),
);

test("captureFormSchema: static fixture → structure only, never values", { skip: chromePath ? false : "no local Chrome/Chromium found" }, async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(join(here, "fixtures", "form-schema.html"), "utf8"));
    const step = await captureFormSchema(page, "Tell us about it");
    const by = Object.fromEntries(step.fields.map((f) => [f.label, f]));
    assert.equal(step.title, "Tell us about it");
    assert.ok(step.fields.every((f) => f.step === "Tell us about it"));

    // Choice buttons grouped; Continue is disabled ⇒ required. Header/footer/nav buttons are not answers.
    assert.deepEqual(by["Tell us about it"], { label: "Tell us about it", type: "button-choice", required: true, options: ["Bus", "Subway", "Ferry"], step: "Tell us about it", selectorHint: "role=button[name=<option>]" });

    assert.deepEqual(by["First name (optional)"], { label: "First name (optional)", type: "text", required: false, step: "Tell us about it", maxLength: null, selectorHint: 'role=textbox[name="First name (optional)"]' });
    assert.equal(by["Email"].required, true, "aria-required");
    assert.equal(by["Phone *"].required, true, "asterisk label");
    assert.equal(by["Phone *"].maxLength, 14, "maxlength attribute");

    const desc = by["Describe the problem (Required)"];
    assert.equal(desc.type, "textarea");
    assert.equal(desc.required, true);
    assert.equal(desc.maxLength, 4000, "visible counter");

    assert.deepEqual({ type: by["Borough"].type, required: by["Borough"].required, options: by["Borough"].options }, { type: "select", required: true, options: ["Manhattan", "Brooklyn", "Queens"] });
    assert.deepEqual({ type: by["How often?"].type, options: by["How often?"].options }, { type: "radio", options: ["Once", "Daily"] });
    assert.equal(by["Send me updates"].type, "checkbox");
    assert.equal(by["When did this happen?"].type, "date");
    assert.equal(by["When did this happen?"].selectorHint, '[placeholder="M/D/YYYY"]');
    assert.equal(step.fields.find((f) => f.type === "file")?.required, false, "hidden file input behind a visible drop zone");
    assert.equal(by["Reference code"]?.maxLength, 12, "input inside an open shadow root");

    // Hidden / display:none inputs are not part of the visible form.
    assert.equal(by["Invisible field"], undefined);
    assert.ok(!step.fields.some((f) => /token/i.test(f.label)));

    // No values: nothing the "resident" typed, checked or selected appears anywhere in the schema.
    const json = JSON.stringify(step);
    for (const v of ["Ada", "secret@example.com", "212-555-0100", "My bus never came", "10/16/2026", "REF-998877", "hidden-token-123", "invisible", "42/4000"]) assert.ok(!json.includes(v), `schema leaked a value: ${v}`);
    assert.ok(!/"(value|checked|selected)"/.test(json), "no value/checked/selected keys");
  } finally {
    await browser.close();
  }
});

test("controlsToFields: date widget pickers collapse into one time field; single stray button is not a choice", () => {
  const base = { placeholder: "", required: false, optionalHint: false, requiredHint: false, maxLength: null, options: [], group: "", boxText: "" };
  const fields = controlsToFields(
    [
      { ...base, kind: "input", inputType: "text", label: "Date and Time of Event", placeholder: "M/D/YYYY" },
      { ...base, kind: "picker", inputType: "listbox", label: "Date and Time of Event" },
      { ...base, kind: "picker", inputType: "listbox", label: ":" },
      { ...base, kind: "picker", inputType: "listbox", label: "Date and Time of Event" },
      { ...base, kind: "button", inputType: "button", label: "File upload zone" },
    ],
    false,
    "Tell us more",
  );
  assert.deepEqual(
    fields.map((f) => [f.label, f.type]),
    [
      ["Date and Time of Event", "date"],
      ["Date and Time of Event (time)", "time"],
    ],
  );
});

test("mergeFormStep: same title replaces in place, new title appends", () => {
  let s = mergeFormStep(null, { title: "A", fields: [] });
  s = mergeFormStep(s, { title: "B", fields: [] });
  s = mergeFormStep(s, { title: "A", fields: [{ label: "x", type: "text", required: true, step: "A" }] });
  assert.deepEqual(
    s.steps.map((x) => [x.title, x.fields.length]),
    [
      ["A", 1],
      ["B", 0],
    ],
  );
  assert.ok(!Number.isNaN(Date.parse(s.capturedAt)));
});
