/** Recipe interpreter unit tests with a fake page (RecipeDriver), no browser. */
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createRecipeAdapter, parseRecipeReference, renderTemplate, templateVars, validateRecipe, type FieldRef, type FormRecipe, type RecipeDriver, type RecipeStep } from "../src/adapters/recipe.js";
import type { AdapterAction, AdapterContext, FormAdapter } from "../src/adapters/types.js";
import { Outcome, type FilingPayload, type WorkerAnswer, type WorkerQuestion } from "../src/protocol.js";
import { testPayload } from "./helpers.js";

/** A fake form: buttons, text fields, a picker; records every driver call. */
class FakePage implements RecipeDriver {
  calls: string[] = [];
  fields: Record<string, { label: string; required: boolean; value: string }> = {};
  buttons: string[] = [];
  pickerOptions: string[] | null = null;
  pageText = "";
  captcha = false;
  submitEnabled = true;
  afterSubmitText = "Thank you. Your case number is 01234567.";
  constructor(init: Partial<FakePage> = {}) {
    Object.assign(this, init);
  }
  private field(ref: FieldRef) {
    return Object.values(this.fields).find((f) => ref.label.test(f.label)) ?? null;
  }
  async goto(url: string) {
    this.calls.push(`goto ${url}`);
  }
  async settle() {}
  async safety() {
    if (this.captcha) throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", "captcha");
  }
  async text() {
    return this.pageText;
  }
  async buttonNames() {
    return this.buttons;
  }
  async clickButton(name: string) {
    if (!this.buttons.includes(name)) throw new Error(`no button ${name}`);
    this.calls.push(`click ${name}`);
  }
  async advance(name: string) {
    this.calls.push(`advance ${name}`);
  }
  async openPicker() {
    this.calls.push("openPicker");
    return this.pickerOptions;
  }
  async choosePickerOption(label: string) {
    this.calls.push(`pickOption ${label}`);
  }
  async closePicker() {
    this.calls.push("closePicker");
  }
  async findField(ref: FieldRef) {
    const f = this.field(ref);
    return f ? { label: f.label, required: f.required } : null;
  }
  async fill(ref: FieldRef, value: string) {
    const f = this.field(ref)!;
    f.value = value;
    this.calls.push(`fill ${f.label}`);
    return value;
  }
  async readField(ref: FieldRef) {
    return this.field(ref)?.value ?? null;
  }
  async buttonEnabled(name: string) {
    if (name === "Send" && this.calls.includes("submit Send")) return null; // the button is gone after submit
    return this.buttons.includes(name) ? this.submitEnabled : null;
  }
  async emptyRequiredFields() {
    return Object.values(this.fields)
      .filter((f) => f.required && !f.value)
      .map((f) => f.label);
  }
  async captureFields() {
    return Object.values(this.fields).map((f) => ({ label: f.label, type: "text", required: f.required }));
  }
  async clickSubmit(name: string) {
    this.calls.push(`submit ${name}`);
    this.pageText = this.afterSubmitText;
  }
  url() {
    return "https://forms.example.gov/thanks?token=secret";
  }
}

function fakeCtx(payload: FilingPayload, answers: Record<string, WorkerAnswer> = {}) {
  const actions: AdapterAction[] = [];
  const questions: WorkerQuestion[] = [];
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  const ctx: AdapterContext = {
    page: {} as Page,
    payload,
    guard: { offAllowlist: false, offAllowlistUrl: null, mainFrameFailures: [] },
    state: { submitClicked: false, finalUrl: null },
    log: (_step, _level, message, data) => logs.push({ message, ...(data ? { data } : {}) }),
    shot: async () => null,
    saveHtml: async () => null,
    checkGuard: () => {},
    ask: async (q, fallback) => {
      questions.push(q);
      const a = answers[q.id];
      if (!a) throw fallback;
      return a;
    },
    action: (a) => actions.push(a),
  };
  return { ctx, actions, questions, logs };
}

async function run(adapter: FormAdapter, ctx: AdapterContext) {
  try {
    await adapter.navigate(ctx);
    await adapter.inspect(ctx);
    await adapter.fill(ctx);
    const v = await adapter.validate(ctx);
    if (!v.ok) return { status: "INVALID", problems: v.problems };
    await adapter.submit(ctx);
    return { status: "CONFIRMED", confirm: await adapter.confirm(ctx) };
  } catch (err) {
    if (err instanceof Outcome) return { status: err.status, errorCode: err.errorCode, message: err.message, data: err.data };
    throw err;
  }
}

const recipe = (steps: RecipeStep[]): FormRecipe => ({ id: "test-form", categoryId: "test-form", version: 1, steps });
const BASIC: RecipeStep[] = [
  { open: { waitFor: "form" } },
  { inspect: { expectText: "Report a problem" } },
  { choose: { value: "{{extra.Kind}}", field: "kind" } },
  { fill: { label: "^describe", value: "{{description}}", required: true, maxLength: 10 } },
  { fill: { label: "^email", value: "{{contact.email}}" } },
  { submitIf: "realSubmitAuthorized", button: "Send" },
  { confirm: { textRegex: "case number is ([A-Z0-9-]{5,})" } },
];
const page = () =>
  new FakePage({
    pageText: "Report a problem",
    buttons: ["Noise", "Smell", "Send"],
    fields: { d: { label: "Describe it", required: true, value: "" }, e: { label: "Email (optional)", required: false, value: "" } },
  });
const payload = (over: Parameters<typeof testPayload>[0] = {}) =>
  testPayload({ category: "test-form", formUrl: "https://forms.example.gov/new", allowedHosts: ["forms.example.gov"], ...over, form: { description: "Loud music all night", extraFields: { Kind: "Noise" }, ...(over.form ?? {}) } });

describe("recipe validation + templates", () => {
  it("validateRecipe accepts the basic recipe and rejects bad structure", () => {
    expect(validateRecipe(recipe(BASIC))).toEqual([]);
    expect(validateRecipe({ ...recipe(BASIC), steps: [{ click: { name: "x" } }] })).toContain("recipe.steps[0] must be open");
    expect(validateRecipe(recipe([{ open: { waitFor: "x" } }, { inspect: {} }, { submitIf: "always", button: "Go" } as unknown as RecipeStep, { confirm: { textRegex: "(x)" } }]))).toContain(
      'recipe.steps[2].submitIf must be "realSubmitAuthorized"',
    );
    expect(validateRecipe(recipe([{ open: { waitFor: "x" } }, { inspect: {} }, { fill: { label: "(", value: "x" } }]))).toContain("recipe.steps[2].fill.label is not a valid regex");
    expect(validateRecipe(recipe([{ open: { waitFor: "x" } }, { inspect: {} }, { when: { text: "x", steps: [{ submitIf: "realSubmitAuthorized", button: "Go" }] } }]))).toContain(
      'recipe.steps[2].when.steps[0]: submitIf cannot be inside "when"',
    );
  });

  it("templateVars + renderTemplate (regex-escaped where used as a regex)", () => {
    const v = templateVars(testPayload({ form: { contactName: "Ada King Lovelace", transit: { line: "s-42 street shuttle", direction: null, station: null, borough: null, incidentTime: null, delayMinutes: null } } }));
    expect(v["contact.firstName"]).toBe("Ada");
    expect(v["contact.lastName"]).toBe("King Lovelace");
    expect(v["transit.lineLabel"]).toBe("S-42 Street Shuttle Line");
    expect(v["contact.email"]).toBe("");
    expect(renderTemplate("^{{transit.line}}-", { "transit.line": "A.B" }, true)).toBe("^A\\.B-");
    expect(renderTemplate("{{nope}}!", {})).toBe("!");
  });

  it("parseRecipeReference uses the last group and needs a digit", () => {
    expect(parseRecipeReference("Your case number is 01234567.", "case number is ([A-Z0-9-]{5,})")).toBe("01234567");
    expect(parseRecipeReference("A confirmation email is on its way", "(confirmation)\\s*([A-Z0-9-]{5,})")).toBeNull();
  });
});

describe("recipe interpreter (fake page)", () => {
  it("dry run: fills from the payload, never types null contact fields, never clicks the submit", async () => {
    const fp = page();
    const { ctx, actions } = fakeCtx(payload());
    const out = await run(createRecipeAdapter(recipe(BASIC), () => fp), ctx);
    expect(out).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: null, data: { dryRun: true } });
    expect(fp.calls).toEqual(["goto https://forms.example.gov/new", "click Noise", "fill Describe it"]);
    expect(fp.fields.d!.value).toBe("Loud music"); // maxLength 10
    expect(fp.fields.e!.value).toBe(""); // contactEmail null ⇒ untouched
    expect(actions).toEqual([
      { kind: "choose", target: "Noise" },
      { kind: "fill", target: "Describe it", chars: 10 },
      { kind: "stop", target: "Send" },
    ]);
    expect(ctx.state.submitClicked).toBe(false);
  });

  it("emits form_schema from inspect (partial) and validate (complete), PII-free", async () => {
    const fp = page();
    const { ctx, logs } = fakeCtx(payload({ form: { contactEmail: "secret@person.org" } }));
    await run(createRecipeAdapter(recipe(BASIC), () => fp), ctx);
    const schemas = logs.filter((l) => l.message === "form_schema").map((l) => l.data!.schema as { complete: boolean; adapter: string; steps: { fields: { label: string }[] }[] });
    expect(schemas.map((s) => [s.adapter, s.complete])).toEqual([
      ["recipe:test-form", false],
      ["recipe:test-form", true],
    ]);
    expect(schemas[1]!.steps.at(-1)!.fields).toEqual([
      { label: "kind", type: "choice", required: true, options: ["Noise"] },
      { label: "Describe it", type: "text", required: true },
      { label: "Email (optional)", type: "text", required: false },
    ]);
    const all = JSON.stringify(schemas);
    expect(all).not.toContain("secret@person.org");
    expect(all).not.toContain("Loud music");
  });

  it("authorized: clicks submit exactly once with submitClicked set first, parses the reference", async () => {
    const fp = page();
    const { ctx } = fakeCtx(payload({ realSubmitAuthorized: true, form: { contactEmail: "a@b.co" } }));
    const out = await run(createRecipeAdapter(recipe(BASIC), () => fp), ctx);
    expect(out).toMatchObject({ status: "CONFIRMED", confirm: { officialRequestNumber: "01234567", receiptUrl: "https://forms.example.gov/thanks" } });
    expect(fp.calls.filter((c) => c.startsWith("submit"))).toEqual(["submit Send"]);
    expect(fp.fields.e!.value).toBe("a@b.co");
    expect(ctx.state.submitClicked).toBe(true);
  });

  it("CAPTCHA ⇒ HUMAN_ACTION_REQUIRED/CAPTCHA before anything is filled", async () => {
    const fp = new FakePage({ ...page(), captcha: true });
    const { ctx, actions } = fakeCtx(payload({ realSubmitAuthorized: true }));
    const out = await run(createRecipeAdapter(recipe(BASIC), () => fp), ctx);
    expect(out).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: "CAPTCHA" });
    expect(actions).toEqual([]);
    expect(fp.calls.some((c) => c.startsWith("fill") || c.startsWith("submit"))).toBe(false);
  });

  it("page changed (inspect expectation fails) ⇒ UNEXPECTED_REQUIRED_FIELD hand-off", async () => {
    const fp = new FakePage({ ...page(), pageText: "Something else entirely" });
    const { ctx } = fakeCtx(payload());
    expect(await run(createRecipeAdapter(recipe(BASIC), () => fp), ctx)).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: "UNEXPECTED_REQUIRED_FIELD" });
  });

  it("tokens match with stripPrefix; no unique match ⇒ ask, answer by option index", async () => {
    const steps: RecipeStep[] = [
      { open: { waitFor: "form" } },
      { inspect: {} },
      { choose: { value: "{{transit.direction}}", match: "tokens", optionsRegex: "Train-", stripPrefix: "^{{transit.line}}( Train)?-", field: "direction", ask: { id: "direction", field: "direction", prompt: "Which way was the {{transit.line}}?" } } },
    ];
    const fp = new FakePage({ buttons: ["A Train-Uptown (Inwood-207 St)", "A Train-Downtown & Queens"] });
    const t = { line: "A", direction: "northbound", station: null, borough: null, incidentTime: null, delayMinutes: null };
    const a = fakeCtx(payload({ form: { transit: t } }));
    await run(createRecipeAdapter(recipe(steps), () => fp), a.ctx);
    expect(a.actions[0]).toEqual({ kind: "choose", target: "A Train-Uptown (Inwood-207 St)" });

    const b = fakeCtx(payload({ form: { transit: { ...t, direction: "Brooklyn-bound" } } }), { direction: { value: "Downtown & Queens", optionIndex: 1 } });
    await run(createRecipeAdapter(recipe(steps), () => new FakePage({ buttons: fp.buttons })), b.ctx);
    expect(b.questions).toEqual([{ id: "direction", field: "direction", prompt: "Which way was the A?", options: ["Uptown (Inwood-207 St)", "Downtown & Queens"], required: true }]);
    expect(b.actions[0]).toEqual({ kind: "choose", target: "A Train-Downtown & Queens" });
  });

  it("required field with no value: ask the resident; no answer ⇒ UNEXPECTED_REQUIRED_FIELD", async () => {
    const steps: RecipeStep[] = [{ open: { waitFor: "form" } }, { inspect: {} }, { fill: { label: "^email", value: "{{contact.email}}", ask: { id: "contact_email", field: "contact_email", prompt: "Email?" } } }];
    const fields = () => ({ e: { label: "Email (required)", required: true, value: "" } });
    const asked = fakeCtx(payload(), { contact_email: { value: "r@x.org" } });
    const fp = new FakePage({ fields: fields() });
    await run(createRecipeAdapter(recipe(steps), () => fp), asked.ctx);
    expect(fp.fields.e!.value).toBe("r@x.org");
    const none = fakeCtx(payload());
    expect(await run(createRecipeAdapter(recipe(steps), () => new FakePage({ fields: fields() })), none.ctx)).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: "UNEXPECTED_REQUIRED_FIELD" });
  });

  it("pick: unique match picked; ambiguous without answer ⇒ skipped (optional); `when` gates steps on page text", async () => {
    const steps: RecipeStep[] = [
      { open: { waitFor: "form" } },
      { inspect: {} },
      { when: { text: "nearest station", steps: [{ pick: { value: "{{transit.station}}", field: "station", ask: { id: "station", field: "station", prompt: "Which {{value}}?" } } }, { continue: { what: "station" } }] } },
      { when: { text: "car number", steps: [{ continue: { what: "car" } }] } },
    ];
    const t = { line: "A", direction: null, station: "14th Street", borough: null, incidentTime: null, delayMinutes: null };
    const one = new FakePage({ pageText: "Which nearest station?", pickerOptions: ["14 St", "W 4 St-Wash Sq"] });
    const a = fakeCtx(payload({ form: { transit: t } }));
    await run(createRecipeAdapter(recipe(steps), () => one), a.ctx);
    expect(a.actions).toEqual([{ kind: "pick", target: "14 St" }, { kind: "continue", target: "Continue" }, { kind: "stop", target: "handoff" }]);

    const two = new FakePage({ pageText: "Which nearest station?", pickerOptions: ["14 St", "14 St-Union Sq"] });
    const b = fakeCtx(payload({ form: { transit: { ...t, station: "14" } } }));
    const out = await run(createRecipeAdapter(recipe(steps), () => two), b.ctx);
    expect(b.questions[0]?.options).toEqual(["14 St", "14 St-Union Sq", "Skip"]);
    expect(b.actions[0]).toEqual({ kind: "skip", target: "station" });
    // A recipe without submitIf is a hand-off recipe: never submits.
    expect(out).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: null, data: { handoff: true } });
    expect(two.calls.some((c) => c.startsWith("submit"))).toBe(false);
  });
});
