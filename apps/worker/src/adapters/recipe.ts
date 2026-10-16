/**
 * Recipe-driven adapter (#9): executes a declarative FormRecipe instead of code. Recipes live in procedural memory /
 * `fixtures/recipes/<categoryId>.json`; the bot sends one inline as `payload.recipe` with `automation: "adapter:recipe"`.
 *
 * Steps (one key per step; `{{var}}` templates resolve from the payload, see templateVars()):
 *   {"open":     {"waitFor": "<css>", "settleMs"?: n}}                       navigate to payload.formUrl (first step)
 *   {"click":    {"role"?: "button", "name": "<text>"}}                       click a button by exact accessible name
 *   {"choose":   {"value": "<tpl>", "from"?: "role=button", "match"?: "exact"|"tokens", "optionsRegex"?: "<re>",
 *                 "stripPrefix"?: "<re tpl>", "field"?: "<name>", "ask"?: {"id","field","prompt"}}}
 *   {"continue": {"name"?: "Continue", "what"?: "<label>"}}                  click Continue, wait for the page to change
 *   {"inspect":  {"expectText"?: "<re>", "expectButtons"?: {"nameRegex": "<re>", "min": n}}}   end of navigate
 *   {"pick":     {"value": "<tpl>", "field": "<name>", "settleMs"?: n, "ask"?: {...}}}       optional listbox picker
 *   {"fill":     {"label": "<re>", "value": "<tpl>", "selector"?: "<css fallback>", "maxLength"?: n, "required"?: bool, "ask"?: {...}}}
 *   {"when":     {"text": "<re>", "steps": [...]}}                            run nested steps only if the page text matches
 *   {"submitIf": "realSubmitAuthorized", "button": "<exact name>"}            the ONLY submit; dry run stops before it
 *   {"confirm":  {"textRegex": "<re, last group = reference>", "doneRegex"?: "<re>"}}
 * Phases: steps before `inspect` = navigate; after it until `submitIf` = fill; then submit; `confirm` = confirm.
 * A recipe without `submitIf` is a hand-off recipe: it fills and stops (HUMAN_ACTION_REQUIRED, never submits).
 *
 * Safety is the interpreter's, not the recipe's: login/CAPTCHA ⇒ HUMAN_ACTION_REQUIRED (no bypass) before every phase;
 * the final click happens only when payload.realSubmitAuthorized === true, exactly once, submitClicked set first;
 * an empty value is never typed (contact fields stay blank when null); an empty required field ⇒ ask or hand off.
 * Page text is data: it only selects among the recipe's own steps (when/inspect), never adds actions.
 */
import type { Locator } from "playwright-core";
import { Outcome, SUBWAY_LINES, sanitizeUrl, type FilingPayload, type FormSchemaField, type FormSchemaStep, type QuestionField, type WorkerStep } from "../protocol.js";
import { detectCaptcha, detectLogin } from "../safety.js";
import { gotoWithRetries, matchByTokens, nameCandidates, needField, needFieldOutcome } from "./common.js";
import { choiceField, emitFormSchema, labelOf, listFields, schemaFields } from "./fields.js";
import type { AdapterContext, ConfirmResult, FormAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Recipe schema (hand-validated: no zod in the sandbox)
// ---------------------------------------------------------------------------
export interface RecipeAsk {
  id: string;
  field: QuestionField;
  prompt: string;
}
export type RecipeStep =
  | { open: { waitFor: string; settleMs?: number } }
  | { click: { role?: "button"; name: string } }
  | { choose: { value: string; from?: "role=button"; match?: "exact" | "tokens"; optionsRegex?: string; stripPrefix?: string; field?: string; ask?: RecipeAsk } }
  | { continue: { name?: string; what?: string } }
  | { inspect: { expectText?: string; expectButtons?: { nameRegex: string; min: number } } }
  | { pick: { value: string; field: string; settleMs?: number; ask?: RecipeAsk } }
  | { fill: { label: string; value: string; selector?: string; maxLength?: number; required?: boolean; ask?: RecipeAsk } }
  | { when: { text: string; steps: RecipeStep[] } }
  | { submitIf: "realSubmitAuthorized"; button: string }
  | { confirm: { textRegex: string; doneRegex?: string } };

export interface FormRecipe {
  /** Recipe id (usually the category id). */
  id: string;
  /** The catalog category this recipe files; must equal payload.category. */
  categoryId: string;
  version: number;
  description?: string;
  steps: RecipeStep[];
}

const STEP_KEYS = ["open", "click", "choose", "continue", "inspect", "pick", "fill", "when", "submitIf", "confirm"] as const;
type StepKey = (typeof STEP_KEYS)[number];
const QFIELDS: QuestionField[] = ["direction", "station", "contact_name", "contact_email", "free_text"];

export function stepKind(s: RecipeStep): StepKey {
  if ("submitIf" in s) return "submitIf";
  return Object.keys(s)[0] as StepKey;
}

/** Structural check. Returns problems; empty = runnable. */
export function validateRecipe(r: unknown): string[] {
  const problems: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(r)) return ["recipe must be an object"];
  if (typeof r.id !== "string" || !r.id) problems.push("recipe.id must be a non-empty string");
  if (typeof r.categoryId !== "string" || !/^[a-z0-9-]+$/.test(r.categoryId)) problems.push("recipe.categoryId must be a catalog slug");
  if (typeof r.version !== "number") problems.push("recipe.version must be a number");
  if (!Array.isArray(r.steps) || !r.steps.length) return [...problems, "recipe.steps must be a non-empty array"];
  const re = (v: unknown, where: string) => {
    if (typeof v !== "string") return problems.push(`${where} must be a string`);
    try {
      new RegExp(v.replace(/\{\{[^}]+\}\}/g, "x"));
    } catch {
      problems.push(`${where} is not a valid regex`);
    }
  };
  const str = (v: unknown, where: string) => typeof v === "string" && v.length > 0 || problems.push(`${where} must be a non-empty string`);
  const ask = (v: unknown, where: string) => {
    if (v === undefined) return;
    if (!isObj(v) || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(v.id) || !QFIELDS.includes(v.field as QuestionField) || typeof v.prompt !== "string") problems.push(`${where} must be {id, field, prompt}`);
  };
  const walk = (steps: unknown[], path: string, nested: boolean) => {
    steps.forEach((raw, i) => {
      const w = `${path}[${i}]`;
      if (!isObj(raw)) return problems.push(`${w} must be an object`);
      const keys = Object.keys(raw).filter((k) => (STEP_KEYS as readonly string[]).includes(k));
      if (keys.length !== 1) return problems.push(`${w} must have exactly one of ${STEP_KEYS.join("|")}`);
      const k = keys[0] as StepKey;
      if (k === "submitIf") {
        if (raw.submitIf !== "realSubmitAuthorized") problems.push(`${w}.submitIf must be "realSubmitAuthorized"`);
        str(raw.button, `${w}.button`);
        if (nested) problems.push(`${w}: submitIf cannot be inside "when"`);
        return;
      }
      const a = raw[k];
      if (!isObj(a)) return problems.push(`${w}.${k} must be an object`);
      if (nested && (k === "open" || k === "inspect" || k === "confirm" || k === "when")) problems.push(`${w}: ${k} cannot be inside "when"`);
      if (k === "open") str(a.waitFor, `${w}.open.waitFor`);
      if (k === "click") str(a.name, `${w}.click.name`);
      if (k === "choose") {
        str(a.value, `${w}.choose.value`);
        if (a.optionsRegex !== undefined) re(a.optionsRegex, `${w}.choose.optionsRegex`);
        if (a.stripPrefix !== undefined) re(a.stripPrefix, `${w}.choose.stripPrefix`);
        if (a.match !== undefined && a.match !== "exact" && a.match !== "tokens") problems.push(`${w}.choose.match must be exact|tokens`);
        ask(a.ask, `${w}.choose.ask`);
      }
      if (k === "pick") {
        str(a.value, `${w}.pick.value`);
        str(a.field, `${w}.pick.field`);
        ask(a.ask, `${w}.pick.ask`);
      }
      if (k === "fill") {
        re(a.label, `${w}.fill.label`);
        str(a.value, `${w}.fill.value`);
        ask(a.ask, `${w}.fill.ask`);
      }
      if (k === "inspect") {
        if (a.expectText !== undefined) re(a.expectText, `${w}.inspect.expectText`);
        if (a.expectButtons !== undefined) re((a.expectButtons as Record<string, unknown>)?.nameRegex, `${w}.inspect.expectButtons.nameRegex`);
      }
      if (k === "confirm") {
        re(a.textRegex, `${w}.confirm.textRegex`);
        if (a.doneRegex !== undefined) re(a.doneRegex, `${w}.confirm.doneRegex`);
      }
      if (k === "when") {
        re(a.text, `${w}.when.text`);
        if (!Array.isArray(a.steps)) problems.push(`${w}.when.steps must be an array`);
        else walk(a.steps, `${w}.when.steps`, true);
      }
    });
  };
  walk(r.steps, "recipe.steps", false);
  if (!problems.length) {
    const kinds = (r.steps as RecipeStep[]).map(stepKind);
    if (kinds[0] !== "open") problems.push("recipe.steps[0] must be open");
    if (kinds.filter((k) => k === "inspect").length !== 1) problems.push("recipe needs exactly one inspect step");
    if (kinds.filter((k) => k === "submitIf").length > 1) problems.push("recipe may have at most one submitIf");
    const si = kinds.indexOf("submitIf");
    const ci = kinds.indexOf("confirm");
    if (si >= 0 && ci !== si + 1) problems.push("submitIf must be followed by confirm");
    if (si < 0 && ci >= 0) problems.push("confirm needs submitIf");
    if (kinds.indexOf("inspect") > (si >= 0 ? si : kinds.length)) problems.push("inspect must come before submitIf");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
/** Template variables from the payload. Unknown ⇒ "". */
export function templateVars(p: FilingPayload): Record<string, string> {
  const f = p.form;
  const t = f.transit ?? null;
  const name = (f.contactName ?? "").trim().split(/\s+/).filter(Boolean);
  const line = SUBWAY_LINES.find((x) => x.toLowerCase() === (t?.line ?? "").trim().toLowerCase()) ?? "";
  const vars: Record<string, string> = {
    description: f.description ?? "",
    address: f.address ?? "",
    borough: f.borough ?? "",
    dateObserved: f.dateObserved ?? "",
    "contact.name": f.contactName ?? "",
    "contact.firstName": name[0] ?? "",
    "contact.lastName": name.length > 1 ? name.slice(1).join(" ") : "",
    "contact.email": f.contactEmail ?? "",
    "contact.phone": f.contactPhone ?? "",
    "transit.line": t?.line ?? "",
    "transit.lineLabel": line ? `${line} Line` : "",
    "transit.direction": t?.direction ?? "",
    "transit.station": t?.station ?? "",
    "transit.borough": t?.borough ?? "",
  };
  for (const [k, v] of Object.entries(f.extraFields ?? {})) vars[`extra.${k}`] = v;
  return vars;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function renderTemplate(tpl: string, vars: Record<string, string>, asRegex = false): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, k: string) => (asRegex ? escapeRe(vars[k] ?? "") : (vars[k] ?? "")));
}

// ---------------------------------------------------------------------------
// Driver: the page operations the interpreter needs. Playwright in production; a fake page in unit tests.
// ---------------------------------------------------------------------------
export interface FieldRef {
  label: RegExp;
  selector?: string;
}

export interface RecipeDriver {
  goto(url: string, waitFor: string): Promise<void>;
  settle(ms: number): Promise<void>;
  /** Throws a HUMAN_ACTION_REQUIRED Outcome on a login wall / CAPTCHA. */
  safety(step: WorkerStep): Promise<void>;
  text(): Promise<string>;
  /** Accessible names of the page's buttons (aria-label, else inner text). */
  buttonNames(): Promise<string[]>;
  /** Click the button with exactly this accessible name (waits until visible). */
  clickButton(name: string): Promise<void>;
  /** Wait until Continue is enabled, click it, wait for the page to change. Disabled ⇒ needField; no change ⇒ FAILED. */
  advance(name: string, what: string): Promise<void>;
  /** Open the visible listbox picker and return its option labels; null when there is no picker. */
  openPicker(): Promise<string[] | null>;
  choosePickerOption(label: string): Promise<void>;
  closePicker(): Promise<void>;
  /** The first text field whose accessible name matches (else the first `selector` match), or null. */
  findField(ref: FieldRef): Promise<{ label: string; required: boolean } | null>;
  /** Fill it and return the read-back value. */
  fill(ref: FieldRef, value: string): Promise<string>;
  readField(ref: FieldRef): Promise<string | null>;
  /** null ⇒ no such button. */
  buttonEnabled(name: string): Promise<boolean | null>;
  /** Labels of visible required fields that are still empty. */
  emptyRequiredFields(): Promise<string[]>;
  /** PII-free schema of the visible fields (labels/types/required/options, never values). */
  captureFields(): Promise<FormSchemaField[]>;
  /** The real submit click (only ever called after the realSubmitAuthorized gate). */
  clickSubmit(name: string): Promise<void>;
  url(): string;
}

const clean = (s: string, n = 120) => s.replace(/\s+/g, " ").trim().slice(0, n);
const stepMs = (ctx: AdapterContext) => Math.max(5000, ctx.payload.limits.stepTimeoutMs || 20000);

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, everyMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return cond().catch(() => false);
}

export function playwrightDriver(ctx: AdapterContext): RecipeDriver {
  const page = ctx.page;
  const bodyText = () => page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const textbox = async ({ label, selector }: FieldRef): Promise<Locator | null> => {
    const cands = [page.getByRole("textbox", { name: label }).first(), page.getByLabel(label).first(), ...(selector ? [page.locator(selector).first()] : [])];
    for (const loc of cands) if (await loc.count()) return loc;
    return null;
  };
  let picker: { list: Locator } | null = null;
  return {
    goto: (url, sel) => gotoWithRetries(ctx, url, sel),
    settle: (ms) => page.waitForTimeout(ms),
    async safety(step) {
      ctx.checkGuard(step);
      const login = await detectLogin(page);
      if (login.detected) {
        await ctx.shot(step, "login-wall");
        throw new Outcome("HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED", "The official form asked for a login. 311Relay never signs in for you.", { ...login, liveViewUrl: ctx.payload.liveViewUrl });
      }
      const cap = await detectCaptcha(page);
      if (cap.detected) {
        await ctx.shot(step, "captcha");
        throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", "The official form showed a CAPTCHA. 311Relay never solves or bypasses CAPTCHAs; please finish in the live browser view.", { captcha: cap, liveViewUrl: ctx.payload.liveViewUrl });
      }
    },
    text: bodyText,
    buttonNames: () => page.getByRole("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") ?? (b as HTMLElement).innerText.trim()).filter(Boolean)),
    async clickButton(name) {
      const btn = page.getByRole("button", { name, exact: true }).first();
      await btn.waitFor({ state: "visible", timeout: stepMs(ctx) });
      await btn.click();
    },
    async advance(name, what) {
      const before = await bodyText();
      const cont = page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}$`, "i") }).first();
      await cont.waitFor({ state: "visible", timeout: stepMs(ctx) });
      if (!(await waitFor(() => cont.isEnabled(), stepMs(ctx)))) {
        await ctx.shot("fill", `continue-disabled-${what}`);
        needField(`The form would not continue past "${what}" (a required choice is missing).`, { step: what, page: clean(before, 400) });
      }
      await cont.click();
      if (!(await waitFor(async () => (await bodyText()) !== before, stepMs(ctx)))) throw new Outcome("FAILED", "BROWSER_ERROR", `The form did not move past "${what}" after ${name}; nothing was submitted.`);
      await page.waitForTimeout(900); // wizard UIs render the next question asynchronously
      ctx.checkGuard("fill");
    },
    async openPicker() {
      const btn = page.locator('button[aria-haspopup="listbox"]').filter({ visible: true }).first();
      if (!(await btn.count())) return null;
      await btn.click();
      const ctl = await btn.getAttribute("aria-controls");
      const list = ctl ? page.locator(`[id="${ctl}"]`) : page.getByRole("listbox").last();
      await waitFor(async () => (await list.getByRole("option").count()) > 0, 5000);
      picker = { list };
      return (await list.getByRole("option").allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    },
    async choosePickerOption(label) {
      if (!picker) throw new Error("picker not open");
      await picker.list.getByRole("option", { name: label, exact: true }).first().click();
      picker = null;
      await page.waitForTimeout(500);
    },
    async closePicker() {
      picker = null;
      await page.keyboard.press("Escape").catch(() => {});
    },
    async findField(ref) {
      const box = await textbox(ref);
      if (!box) return null;
      const l = await labelOf(box);
      const required = !/optional/i.test(l) && (/required|\*/i.test(l) || (await box.evaluate((e) => (e as HTMLInputElement).required || e.getAttribute("aria-required") === "true").catch(() => false)));
      return { label: l, required };
    },
    async fill(ref, value) {
      const box = await textbox(ref);
      if (!box) throw new Error(`field ${ref.label} not found`);
      await box.fill(value);
      return box.inputValue();
    },
    async readField(ref) {
      const box = await textbox(ref);
      return box ? box.inputValue() : null;
    },
    async buttonEnabled(name) {
      const b = page.getByRole("button", { name, exact: true });
      if (!(await b.count())) return null;
      return b.first().isEnabled();
    },
    async emptyRequiredFields() {
      const fields = await listFields(page);
      const out: string[] = [];
      for (const f of fields) {
        if (!f.required || /optional/i.test(f.label) || f.type === "checkbox" || f.type === "radio" || f.type === "file") continue;
        const v = await page.locator("input,select,textarea").nth(f.index).inputValue().catch(() => "x");
        if (!v) out.push(f.label || "an unlabeled field");
      }
      return out;
    },
    captureFields: async () => schemaFields(await listFields(page)),
    async clickSubmit(name) {
      const btn = page.getByRole("button", { name, exact: true }).first();
      await btn.click({ noWaitAfter: true, timeout: 10_000 });
    },
    url: () => page.url(),
  };
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------
export function createRecipeAdapter(recipe: FormRecipe, driverFor: (ctx: AdapterContext) => RecipeDriver = playwrightDriver): FormAdapter {
  const inspectAt = recipe.steps.findIndex((s) => stepKind(s) === "inspect");
  const submitAt = recipe.steps.findIndex((s) => stepKind(s) === "submitIf");
  const navigateSteps = recipe.steps.slice(0, inspectAt);
  const inspectStep = recipe.steps[inspectAt] as Extract<RecipeStep, { inspect: unknown }>;
  const fillSteps = recipe.steps.slice(inspectAt + 1, submitAt >= 0 ? submitAt : undefined);
  const submitStep = submitAt >= 0 ? (recipe.steps[submitAt] as Extract<RecipeStep, { submitIf: unknown }>) : null;
  const confirmStep = recipe.steps.find((s) => stepKind(s) === "confirm") as Extract<RecipeStep, { confirm: unknown }> | undefined;

  let d: RecipeDriver | null = null;
  const filled: { fields: { ref: FieldRef; name: string; value: string; readBackOk: boolean }[]; chosen: string[]; picked: string[]; skipped: string[]; answered: string[] } = { fields: [], chosen: [], picked: [], skipped: [], answered: [] };
  const drv = (ctx: AdapterContext) => (d ??= driverFor(ctx));
  // form_schema: the current step's choice fields + visible fields, closed at each `continue`.
  const schemaSteps: FormSchemaStep[] = [];
  let pendingChoices: FormSchemaField[] = [];
  const closeSchemaStep = async (ctx: AdapterContext, name: string) => {
    const fields = await drv(ctx).captureFields().catch(() => [] as FormSchemaField[]);
    schemaSteps.push({ name, fields: [...pendingChoices, ...fields] });
    pendingChoices = [];
  };
  const vars = (ctx: AdapterContext) => templateVars(ctx.payload);

  async function askOrThrow(ctx: AdapterContext, ask: RecipeAsk | undefined, options: string[] | undefined, required: boolean, fallback: Outcome) {
    if (!ask) throw fallback;
    const a = await ctx.ask({ id: ask.id, field: ask.field, prompt: renderTemplate(ask.prompt, vars(ctx)), ...(options?.length ? { options } : {}), required }, fallback);
    filled.answered.push(ask.field);
    return a;
  }

  async function run(ctx: AdapterContext, phase: WorkerStep, step: RecipeStep): Promise<void> {
    const v = vars(ctx);
    const D = drv(ctx);
    const k = stepKind(step);
    if ("open" in step) {
      const url = ctx.payload.formUrl;
      ctx.log("navigate", "info", `recipe ${recipe.id}: opening the official form`, { url: sanitizeUrl(url) });
      await D.goto(url, step.open.waitFor);
      if (step.open.settleMs) await D.settle(step.open.settleMs);
      await ctx.shot("navigate", "form-loaded");
      await D.safety("navigate");
    } else if ("click" in step) {
      const name = renderTemplate(step.click.name, v);
      await D.clickButton(name);
      ctx.action({ kind: "click", target: name });
    } else if ("choose" in step) {
      const c = step.choose;
      const value = renderTemplate(c.value, v).trim();
      const field = c.field ?? "choice";
      let options: string[] = [];
      if (c.optionsRegex) {
        const re = new RegExp(renderTemplate(c.optionsRegex, v, true));
        await waitFor(async () => (await D.buttonNames()).some((n) => re.test(n)), stepMs(ctx));
        options = (await D.buttonNames()).filter((n) => re.test(n));
      }
      const core = c.stripPrefix ? ((re: RegExp) => (o: string) => o.replace(re, "").trim())(new RegExp(renderTemplate(c.stripPrefix, v, true))) : (o: string) => o;
      let pick: string | null = null;
      if (c.match === "tokens") pick = matchByTokens(value, options, core);
      else pick = value ? (options.length ? (options.find((o) => o === value) ?? null) : value) : null;
      if (!pick) {
        await ctx.shot(phase, `${field.replace(/\W+/g, "-")}-needed`, `Options shown by the form for ${field}`);
        const fallback = needFieldOutcome(
          options.length ? `The form asks for ${field}; offers ${options.map((o) => `"${core(o)}"`).join(" or ")} (${value ? `"${clean(value, 60)}" does not clearly match one` : "no value given"}).` : `The form needs ${field}, which is missing from the approved draft.`,
          { field, options, optionsShort: options.map(core), got: value || null },
        );
        if (options.length < 2) throw fallback;
        const a = await askOrThrow(ctx, c.ask, options.map(core), true, fallback);
        pick = a.optionIndex !== undefined ? (options[a.optionIndex] ?? null) : c.match === "tokens" ? matchByTokens(a.value, options, core) : (options.find((o) => o === a.value) ?? null);
        if (!pick) throw fallback;
      }
      pendingChoices.push(choiceField(field, options.length ? options : [pick], true));
      await D.clickButton(pick);
      filled.chosen.push(pick);
      ctx.action({ kind: "choose", target: pick });
      ctx.log(phase, "info", `chose "${pick}"`, { field });
    } else if ("continue" in step) {
      const name = step.continue.name ?? "Continue";
      if (phase === "fill") await closeSchemaStep(ctx, step.continue.what ?? `step ${schemaSteps.length + 1}`);
      await D.advance(name, step.continue.what ?? "this step");
      ctx.action({ kind: "continue", target: name });
    } else if ("pick" in step) {
      const p = step.pick;
      if (p.settleMs) await D.settle(p.settleMs);
      const want = renderTemplate(p.value, v).trim();
      if (!want) {
        filled.skipped.push(`${p.field} (not given)`);
        ctx.action({ kind: "skip", target: p.field });
        return;
      }
      let options = await D.openPicker();
      if (!options) {
        filled.skipped.push(`${p.field} (picker not found)`);
        ctx.action({ kind: "skip", target: p.field });
        return;
      }
      const cands = nameCandidates(want, options);
      let hit: string | null = cands.length === 1 ? cands[0]! : null;
      if (!hit && p.ask) {
        await D.closePicker();
        const top = cands.slice(0, 5);
        const skipped = new Error("optional question unanswered");
        const a = await ctx
          .ask(
            { id: p.ask.id, field: p.ask.field, prompt: renderTemplate(p.ask.prompt, { ...v, value: clean(want, 60) }), options: [...top, "Skip"], required: false },
            skipped,
          )
          .catch((err) => {
            if (err === skipped) return null;
            throw err;
          });
        const chosen = a && a.optionIndex !== undefined ? (a.optionIndex < top.length ? top[a.optionIndex]! : null) : a && !/^skip$/i.test(a.value) ? (nameCandidates(a.value, options).length === 1 ? nameCandidates(a.value, options)[0]! : null) : null;
        if (chosen) {
          options = (await D.openPicker()) ?? [];
          hit = options.includes(chosen) ? chosen : null;
          if (hit) filled.answered.push(p.field);
          else await D.closePicker();
        }
      }
      if (hit) {
        await D.choosePickerOption(hit);
        filled.picked.push(hit);
        ctx.action({ kind: "pick", target: hit });
      } else {
        await D.closePicker();
        filled.skipped.push(`${p.field} ("${clean(want, 60)}" ${cands.length ? "ambiguous" : "not listed"})`);
        ctx.action({ kind: "skip", target: p.field });
      }
    } else if ("fill" in step) {
      const f = step.fill;
      const ref: FieldRef = { label: new RegExp(renderTemplate(f.label, v, true), "i"), ...(f.selector ? { selector: f.selector } : {}) };
      const field = await D.findField(ref);
      let value = renderTemplate(f.value, v);
      if (!field) {
        if (f.required) needField(`The form no longer has the field "${f.label}"; nothing was submitted.`, { field: f.label });
        if (value) ctx.log(phase, "info", `the form has no "${f.label}" field; not sent`);
        return;
      }
      if (!value.trim()) {
        // Never invent a value (null contact fields stay blank). Required ⇒ ask the resident, else hand off.
        if (!(f.required || field.required)) return;
        const fallback = needFieldOutcome(`The form requires "${field.label}", which is not in the approved draft.`, { field: field.label });
        value = (await askOrThrow(ctx, f.ask, undefined, true, fallback)).value;
        if (!value.trim()) throw fallback;
      }
      const text = f.maxLength ? value.slice(0, f.maxLength) : value;
      if (text.length < value.length) ctx.log(phase, "warn", `"${field.label}" truncated to ${f.maxLength} chars (form limit)`);
      const back = await D.fill(ref, text);
      filled.fields.push({ ref, name: field.label, value: text, readBackOk: back === text });
      ctx.action({ kind: "fill", target: field.label || f.label, chars: text.length });
      if (back !== text) ctx.log(phase, "warn", `"${field.label}" read-back differs`);
    } else if ("when" in step) {
      const re = new RegExp(renderTemplate(step.when.text, v, true), "i");
      if (!re.test(await D.text())) return;
      for (const s of step.when.steps) await run(ctx, phase, s);
    } else {
      throw new Outcome("FAILED", "WORKER_CRASH", `Recipe step "${k}" is not allowed in ${phase}.`);
    }
  }

  return {
    id: `recipe:${recipe.id}`,

    async navigate(ctx) {
      for (const s of navigateSteps) await run(ctx, "navigate", s);
      await ctx.shot("navigate", "recipe-navigated");
    },

    async inspect(ctx) {
      const D = drv(ctx);
      await D.safety("inspect");
      const i = inspectStep.inspect;
      const v = vars(ctx);
      let ok = true;
      if (i.expectText) ok &&= new RegExp(renderTemplate(i.expectText, v, true), "i").test(await D.text());
      if (i.expectButtons) {
        const re = new RegExp(renderTemplate(i.expectButtons.nameRegex, v, true));
        ok &&= (await D.buttonNames()).filter((n) => re.test(n)).length >= i.expectButtons.min;
      }
      if (!ok) {
        await ctx.shot("inspect", "unexpected-step");
        needField(`The form changed: recipe "${recipe.id}" expected a different page here.`, { page: clean(await D.text(), 500) });
      }
      const first = await D.captureFields().catch(() => [] as FormSchemaField[]);
      if (i.expectButtons) {
        const re = new RegExp(renderTemplate(i.expectButtons.nameRegex, v, true));
        first.unshift(choiceField("choice", (await D.buttonNames()).filter((n) => re.test(n)), true));
      }
      emitFormSchema(ctx, "inspect", `recipe:${recipe.id}`, [{ name: "first step", fields: first }], false);
      return { requiredKnown: fillSteps.flatMap((s) => ("fill" in s && s.fill.required ? [s.fill.label] : "choose" in s ? [s.choose.field ?? "choice"] : [])) };
    },

    async fill(ctx) {
      for (const s of fillSteps) {
        await drv(ctx).safety("fill");
        await run(ctx, "fill", s);
      }
    },

    async validate(ctx) {
      const D = drv(ctx);
      await D.safety("validate");
      const problems: string[] = [];
      for (const f of filled.fields) {
        // Fields on earlier wizard steps are gone from the page: their fill-time read-back stands.
        const back = await D.readField(f.ref);
        if (!f.readBackOk || (back !== null && back !== f.value)) problems.push(`${f.name}: read-back did not match`);
      }
      for (const l of await D.emptyRequiredFields()) problems.push(`required field "${l}" is empty`);
      await closeSchemaStep(ctx, "final");
      emitFormSchema(ctx, "validate", `recipe:${recipe.id}`, schemaSteps, true);
      if (submitStep) {
        const en = await D.buttonEnabled(submitStep.button);
        if (!en) problems.push(`"${submitStep.button}" button not available`);
      }
      ctx.log("validate", problems.length ? "warn" : "info", problems.length ? "verification problems" : "all recipe values reflected on the form", { chosen: filled.chosen, picked: filled.picked, fields: filled.fields.map((f) => f.name), skipped: filled.skipped, problems });
      await ctx.shot("validate", "final-pre-submit", submitStep ? `Final page, filled, before "${submitStep.button}"` : "Final page, filled (hand-off recipe)");
      return { ok: problems.length === 0, problems };
    },

    async submit(ctx) {
      const summary = { recipe: recipe.id, chosen: filled.chosen, picked: filled.picked, fields: filled.fields.map((f) => f.name), skipped: filled.skipped, answeredLive: filled.answered };
      if (!submitStep) {
        ctx.action({ kind: "stop", target: "handoff" });
        await ctx.saveHtml("submit", "handoff");
        throw new Outcome("HUMAN_ACTION_REQUIRED", null, "I filled the official form. Please review and submit it yourself in the live browser view.", { handoff: true, liveViewUrl: ctx.payload.liveViewUrl, filled: summary });
      }
      if (ctx.payload.realSubmitAuthorized !== true) {
        ctx.log("submit", "warn", `dry run: realSubmitAuthorized is not true; NOT clicking "${submitStep.button}"`);
        await ctx.shot("submit", "dry-run-stop", `Dry run: everything filled, stopped before "${submitStep.button}"`);
        await ctx.saveHtml("submit", "dry-run-stop");
        ctx.action({ kind: "stop", target: submitStep.button });
        throw new Outcome("HUMAN_ACTION_REQUIRED", null, "Stopped before the final Submit (dry run). Everything is filled in.", { dryRun: true, liveViewUrl: ctx.payload.liveViewUrl, filled: summary });
      }
      const D = drv(ctx);
      if (!(await D.buttonEnabled(submitStep.button))) throw new Outcome("FAILED", "BROWSER_ERROR", `"${submitStep.button}" is not available; nothing was submitted.`);
      ctx.log("submit", "warn", `realSubmitAuthorized=true: clicking "${submitStep.button}" exactly once`);
      ctx.state.submitClicked = true;
      ctx.action({ kind: "submit", target: submitStep.button });
      await D.clickSubmit(submitStep.button);
    },

    async confirm(ctx): Promise<ConfirmResult> {
      const D = drv(ctx);
      const c = confirmStep!.confirm;
      const done = new RegExp(c.doneRegex ?? "thank you|thanks for|we('| ha)ve received|has been (received|submitted)", "i");
      const button = submitStep!.button;
      await waitFor(async () => done.test(await D.text()) || (await D.buttonEnabled(button)) === null, Math.max(30_000, stepMs(ctx) * 2), 500);
      await D.settle(1500);
      ctx.checkGuard("confirm");
      const text = await D.text();
      await ctx.shot("confirm", "confirmation", "Page after Submit");
      await ctx.saveHtml("confirm", "confirmation");
      ctx.log("confirm", "info", "page text after submit (data only)", { text: text.slice(0, 1500) });
      if ((await D.buttonEnabled(button)) !== null && !done.test(text))
        throw new Outcome("SUBMISSION_UNKNOWN", "NO_CONFIRMATION", `Submit was clicked but the page did not confirm receipt (still showing "${button}"). No automatic retry.`, { pageText: text.slice(0, 600) });
      const ref = parseRecipeReference(text, c.textRegex);
      const lines = text.split("\n");
      const idx = lines.findIndex((l) => done.test(l) || (ref ? l.includes(ref) : false));
      const confirmationText = done.test(text) || ref ? lines.slice(Math.max(0, idx - 2), idx + 8).join("\n").slice(0, 1200) || text.slice(0, 1200) : null;
      return { officialRequestNumber: ref, confirmationText, receiptUrl: sanitizeUrl(D.url()) };
    },
  };
}

/** The recipe's reference regex; the LAST capture group is the reference and must contain a digit (never invented). */
export function parseRecipeReference(text: string, textRegex: string): string | null {
  for (const m of text.matchAll(new RegExp(textRegex, "gi"))) {
    const tok = [...m].slice(1).reverse().find((g) => g !== undefined);
    if (tok && /\d/.test(tok)) return tok.replace(/-+$/, "");
  }
  return null;
}
