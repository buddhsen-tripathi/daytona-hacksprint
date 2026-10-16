import type { Page } from "playwright-core";
import { Outcome, nowIso, type FilingPayload, type FormField, type FormFieldType, type FormSchema } from "../protocol.js";
import type { AdapterContext } from "./types.js";
import { normLabel } from "./fields.js";

export const BOROUGHS = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"] as const;
export type Borough = (typeof BOROUGHS)[number];

/** "Ada Lovelace" → {first:"Ada", last:"Lovelace"}; "Ada King Lovelace" → last "King Lovelace". Single word / null ⇒ null. */
export function splitName(contactName: string | null): { first: string; last: string } | null {
  const parts = (contactName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/** ISO YYYY-MM-DD (or full ISO timestamp) → MM/DD/YYYY. Invalid ⇒ null (leave blank, never invent). */
export function isoToUsDate(iso: string | null): string | null {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

export function normalizeBorough(b: string | null | undefined): Borough | null {
  const s = (b ?? "").trim().toLowerCase().replace(/^the\s+/, "");
  if (!s) return null;
  if (s === "manhattan" || s === "new york" || s === "new york county") return "Manhattan";
  if (s === "bronx") return "Bronx";
  if (s === "brooklyn" || s === "kings") return "Brooklyn";
  if (s === "queens") return "Queens";
  if (s === "staten island" || s === "richmond") return "Staten Island";
  return null;
}

export interface ParsedLocation {
  borough: Borough | null;
  houseNumber: string | null;
  onStreet: string | null;
  crossStreet1: string | null;
  crossStreet2: string | null;
  locationType: "Street" | "Intersection";
}

/**
 * Best-effort parse of a normalized address.
 *  "1515 Broadway, Manhattan"                  → house 1515, on "Broadway"
 *  "Broadway & W 45th St, Manhattan"           → on "Broadway", cross1 "W 45th St", Intersection
 *  "Atlantic Ave between Nevins St and 3rd Ave" → on "Atlantic Ave", cross1 "Nevins St", cross2 "3rd Ave"
 * Borough: payload.form.borough first, else any comma part naming a borough.
 */
export function parseAddress(address: string | null, borough: string | null): ParsedLocation {
  const out: ParsedLocation = { borough: normalizeBorough(borough), houseNumber: null, onStreet: null, crossStreet1: null, crossStreet2: null, locationType: "Street" };
  const parts = (address ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!out.borough) for (const p of parts.slice(1)) if ((out.borough = normalizeBorough(p))) break;
  const first = parts[0];
  if (!first) return out;
  const between = first.match(/^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/i);
  if (between) {
    out.onStreet = between[1]!.trim();
    out.crossStreet1 = between[2]!.trim();
    out.crossStreet2 = between[3]!.trim();
    return out;
  }
  const inter = first.split(/\s+(?:&|and|at)\s+|\s*\/\s*/i);
  if (inter.length >= 2 && inter[0] && inter[1]) {
    out.onStreet = inter[0].trim();
    out.crossStreet1 = inter[1].trim();
    out.locationType = "Intersection";
    return out;
  }
  const hn = first.match(/^(\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/);
  if (hn) {
    out.houseNumber = hn[1]!;
    out.onStreet = hn[2]!.trim();
  } else out.onStreet = first;
  return out;
}

export function needField(message: string, data?: Record<string, unknown>): never {
  throw needFieldOutcome(message, data);
}

/** The HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD outcome without throwing (ctx.ask fallback). */
export function needFieldOutcome(message: string, data?: Record<string, unknown>): Outcome {
  return new Outcome("HUMAN_ACTION_REQUIRED", "UNEXPECTED_REQUIRED_FIELD", message, data);
}

/** goto with bounded retries (navigation only — never used after submit). */
export async function gotoWithRetries(ctx: AdapterContext, url: string, waitForSelector: string) {
  const { page, payload } = ctx;
  const attempts = Math.max(1, Math.min(5, (payload.limits.maxNavigationRetries ?? 0) + 1));
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: payload.limits.stepTimeoutMs });
      ctx.checkGuard("navigate");
      if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
      await page.waitForSelector(waitForSelector, { state: "visible", timeout: payload.limits.stepTimeoutMs });
      return;
    } catch (err) {
      if (err instanceof Outcome) throw err;
      ctx.checkGuard("navigate");
      lastErr = err;
      ctx.log("navigate", "warn", `navigation attempt ${i}/${attempts} failed: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
    }
  }
  throw new Outcome("FAILED", "NAVIGATION_FAILED", `Could not open the reporting form after ${attempts} attempt(s): ${String((lastErr as Error)?.message ?? lastErr).split("\n")[0]}`);
}

export async function textOf(page: Page, selector: string): Promise<string | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  const t = (await loc.innerText({ timeout: 2000 }).catch(() => "")).trim();
  return t || null;
}

/** Field checks: does this text input accept free text of this length? */
export async function acceptsFreeText(page: Page, selector: string, text: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, t) => {
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
      if (el instanceof HTMLInputElement && !["text", "search", ""].includes(el.type)) return false;
      if (el.readOnly || el.disabled) return false;
      if (el.getAttribute("pattern")) {
        try {
          if (!new RegExp(`^(?:${el.getAttribute("pattern")})$`).test(t)) return false;
        } catch {
          return false;
        }
      }
      if (el.maxLength > 0 && el.maxLength < t.length) return false;
      if (el.getAttribute("list")) return false; // autocomplete-backed fields expect known values
      return true;
    }, text)
    .catch(() => false);
}

export function payloadSummary(p: FilingPayload) {
  return {
    target: p.target,
    category: p.category,
    hasContactName: !!p.form.contactName,
    hasEmail: !!p.form.contactEmail,
    hasPhone: !!p.form.contactPhone,
    hasAddress: !!p.form.address,
    borough: p.form.borough,
  };
}

// ---------------------------------------------------------------------------
// Option matching shared by the hand-written MTA adapter and the recipe interpreter (identical behaviour).
// ---------------------------------------------------------------------------
const STOP = new Set(["the", "to", "toward", "towards", "train", "trains", "line", "bound", "going", "heading", "headed", "direction", "in", "on", "at", "st", "av", "ave", "avs", "street", "avenue", "and", "of", "from", "into", "a", "an", "way", "side", "service", "-", "&"]);
const SYN: Record<string, string> = { northbound: "uptown", north: "uptown", up: "uptown", southbound: "downtown", south: "downtown", down: "downtown", center: "ctr", centre: "ctr", square: "sq", wtc: "ctr", bx: "bronx", bk: "brooklyn", bklyn: "brooklyn", city: "manhattan" };

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/-bound\b/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => SYN[t] ?? t);
}

/**
 * Pick the option whose (core) label best overlaps what the resident said, token-wise (synonyms: northbound→uptown, …).
 * Unique best overlap wins; zero overlap or a tie ⇒ null (ask, never guess).
 */
export function matchByTokens(said: string | null | undefined, options: string[], core: (label: string) => string = (l) => l): string | null {
  const want = new Set(tokens(said ?? ""));
  if (!want.size || !options.length) return null;
  const scored = options.map((o) => {
    const have = new Set(tokens(core(o)));
    let score = 0;
    for (const t of want) if (have.has(t)) score++;
    return { o, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]!.score === 0) return null;
  if (scored.length > 1 && scored[1]!.score === scored[0]!.score) return null;
  return scored[0]!.o;
}

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "av")
    .replace(/\bave\b/g, "av")
    .replace(/\bavenues\b|\bavs\b/g, "avs")
    .replace(/\bsquare\b/g, "sq")
    .replace(/\bcenter\b/g, "ctr")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bwest\b/g, "w")
    .replace(/\beast\b/g, "e")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\bstation\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Options for what the resident said: exact (normalized: street→st, 14th→14, …) matches, else whole-word contains matches. */
export function nameCandidates(said: string | null | undefined, options: string[]): string[] {
  const w = normName(said ?? "");
  if (!w) return [];
  const exact = options.filter((o) => normName(o) === w);
  if (exact.length) return exact;
  const re = new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  return options.filter((o) => re.test(normName(o)));
}

// ---------------------------------------------------------------------------
// Form schema capture (issue #11): structure only, never values
// ---------------------------------------------------------------------------

export interface FormStepSchema {
  title: string;
  fields: FormField[];
}

/** Raw control description produced in the page. No values: `.value` / `.checked` / the selected option are never read. */
export interface RawControl {
  kind: "input" | "textarea" | "select" | "picker" | "button" | "radio" | "checkbox" | "file";
  inputType: string;
  label: string;
  placeholder: string;
  required: boolean;
  optionalHint: boolean;
  requiredHint: boolean;
  maxLength: number | null;
  options: string[];
  group: string;
  /** Visible text of the container around a picker (groups date/time pickers). */
  boxText: string;
}

/** Buttons that are wizard navigation / page chrome, not answers. */
const NAV_BUTTON_RE = /^(continue|next|back|previous|prev|cancel|close|done|ok|get started|start|submit\b.*|send\b.*|log ?in|sign ?in|sign ?up|skip\b.*|now|today|clear|reset|menu|search|english|help|info|more info|show more|upload\b.*|\d{1,2})$/i;

/**
 * Describe the visible form controls on the current page/step: label, type, required, options, maxLength, plus a
 * role/label-based selector hint. STRUCTURE ONLY: never reads `.value`, `.checked` or the selected option.
 * Wizard answers rendered as buttons are grouped into one `button-choice` field labelled with the step title; it is
 * `required` when the page's Continue/Next button is disabled before a choice is made.
 * Generic: no site-specific selectors. Adapters may post-process (relabel, attach picker options they read themselves).
 */
export async function captureFormSchema(page: Page, stepTitle: string): Promise<FormStepSchema> {
  const raw = await page.evaluate((navSrc: string) => {
    const navRe = new RegExp(navSrc, "i");
    const txt = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const shown = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el as HTMLElement);
      return st.visibility !== "hidden" && st.display !== "none";
    };
    // Shadow-DOM aware traversal (Salesforce LWC / web components render form widgets inside open shadow roots).
    const up = (n: Element): Element | null => n.parentElement ?? ((n.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
    const closestDeep = (el: Element, sel: string): Element | null => {
      for (let n: Element | null = el; n; n = up(n)) if (n.matches(sel)) return n;
      return null;
    };
    const deepAll = (root: Document | ShadowRoot, sel: string, acc: Element[] = []): Element[] => {
      for (const n of Array.from(root.querySelectorAll("*"))) {
        if (n.matches(sel)) acc.push(n);
        if (n.shadowRoot) deepAll(n.shadowRoot, sel, acc);
      }
      return acc;
    };
    const rootOf = (el: Element) => el.getRootNode() as Document | ShadowRoot;
    const chrome = (el: Element) => !!closestDeep(el, '[aria-hidden="true"],[hidden],header,footer,nav,[role=banner],[role=contentinfo],[role=navigation]');
    const byIds = (el: Element, ids: string | null) =>
      txt(
        (ids ?? "")
          .split(/\s+/)
          .map((id) => (id ? ((rootOf(el).getElementById(id) as HTMLElement | null)?.innerText ?? "") : ""))
          .join(" "),
      );
    /** Short visible text just before the control (labels rendered as sibling divs are common in SPA form kits). */
    const nearbyLabel = (el: Element) => {
      let node: Element | null = el;
      for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = up(node)) {
        for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.querySelector("input,textarea,select,button")) break;
          const t = txt((sib as HTMLElement).innerText);
          if (t && t.length <= 120 && !/^\d+\s*\/\s*\d+$/.test(t)) return t;
        }
      }
      return "";
    };
    const idLike = (s: string) => !s || /^[A-Za-z_]*\d*(Id|ID|_id)$/.test(s) || /^[-\s]+$/.test(s);
    const labelOf = (el: Element) => {
      // <label for=id> also labels ARIA widgets (div role=checkbox), which `.labels` does not cover.
      const lab = (el as HTMLInputElement).labels?.[0] ?? (el.id ? rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      const cands = [lab ? txt((lab as HTMLElement).innerText) : "", txt(el.getAttribute("aria-label")), byIds(el, el.getAttribute("aria-labelledby")), txt(closestDeep(el, "fieldset")?.querySelector("legend")?.textContent), nearbyLabel(el)];
      for (const c of cands) if (!idLike(c)) return c.slice(0, 160);
      const parent = up(el);
      return txt(el.getAttribute("placeholder")) || txt(parent?.getAttribute("aria-label")) || txt(el.getAttribute("name"));
    };
    /** Visible "12/4000"-style character counter near a text control. */
    const counterMax = (el: Element) => {
      let node: Element | null = up(el);
      for (let depth = 0; node && depth < 4; depth++, node = up(node)) {
        // Stop once the container holds other controls: their counter is not ours.
        if (node.querySelectorAll("input:not([type=hidden]),textarea,select").length > 1) break;
        for (const line of ((node as HTMLElement).innerText ?? "").split("\n")) {
          const m = line.trim().match(/^\d+\s*\/\s*(\d+)$/);
          if (m) return Number(m[1]);
        }
      }
      return null;
    };
    const hints = (label: string, el: Element) => {
      const near = nearbyLabel(el);
      return {
        optionalHint: /\boptional\b/i.test(label) || /\(optional\)/i.test(near),
        requiredHint: /\(required\)|\brequired\b|\*\s*$/i.test(label) || /\(required\)|\*\s*$/i.test(near),
      };
    };
    const out: RawControl[] = [];
    const seenRadio = new Set<string>();
    for (const el of deepAll(document, "input,textarea,select,button,[role=button],[role=combobox],[role=radio],[role=checkbox]")) {
      if (chrome(el)) continue;
      // File inputs are usually visually hidden behind a styled drop zone: keep them when their wrapper is shown.
      const isFile = el instanceof HTMLInputElement && el.type === "file";
      const wrapper = up(el);
      if (!shown(el) && !(isFile && wrapper && shown(wrapper))) continue;
      const base = { placeholder: txt(el.getAttribute("placeholder")), maxLength: null as number | null, options: [] as string[], group: "", boxText: "" };
      const ariaReq = el.getAttribute("aria-required") === "true";
      if (el instanceof HTMLInputElement) {
        const t = (el.type || "text").toLowerCase();
        if (["hidden", "submit", "button", "reset", "image"].includes(t)) continue;
        const label = labelOf(el);
        if (t === "radio") {
          const key = el.name || label;
          if (seenRadio.has(key)) continue;
          seenRadio.add(key);
          const group = el.name ? (Array.from(rootOf(el).querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)) as HTMLInputElement[]) : [el];
          const fs = closestDeep(el, "fieldset");
          const legend = txt(fs?.querySelector("legend")?.textContent) || (fs ? nearbyLabel(fs) : "") || key;
          out.push({ ...base, kind: "radio", inputType: t, label: legend, required: group.some((g) => g.required) || ariaReq, ...hints(legend, el), options: group.map((g) => txt(g.labels?.[0]?.innerText) || g.value).filter(Boolean), group: el.name });
          continue;
        }
        const kind = t === "checkbox" ? "checkbox" : t === "file" ? "file" : "input";
        out.push({ ...base, kind, inputType: t, label, required: el.required || ariaReq, ...hints(label, el), maxLength: kind !== "input" ? null : el.maxLength > 0 ? el.maxLength : counterMax(el) });
      } else if (el instanceof HTMLTextAreaElement) {
        const label = labelOf(el);
        out.push({ ...base, kind: "textarea", inputType: "textarea", label, required: el.required || ariaReq, ...hints(label, el), maxLength: el.maxLength > 0 ? el.maxLength : counterMax(el) });
      } else if (el instanceof HTMLSelectElement) {
        const label = labelOf(el);
        out.push({ ...base, kind: "select", inputType: "select", label, required: el.required || ariaReq, ...hints(label, el), options: Array.from(el.options).map((o) => txt(o.text)).filter(Boolean) });
      } else if (el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("role") === "combobox") {
        const label = labelOf(el);
        const list = rootOf(el).getElementById(el.getAttribute("aria-controls") ?? "");
        const options = list ? Array.from(list.querySelectorAll("[role=option]")).map((o) => txt((o as HTMLElement).innerText)).filter(Boolean) : [];
        const p1 = up(el);
        const p2 = p1 && up(p1);
        const box = (p2 && up(p2)) as HTMLElement | null;
        out.push({ ...base, kind: "picker", inputType: "listbox", label, required: ariaReq, ...hints(label, el), options, boxText: txt(box?.innerText).slice(0, 200) });
      } else if (el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox") {
        const label = labelOf(el);
        out.push({ ...base, kind: el.getAttribute("role") === "radio" ? "radio" : "checkbox", inputType: el.getAttribute("role")!, label, required: ariaReq, ...hints(label, el) });
      } else {
        // A button: candidate wizard answer. Disabled buttons (steppers) and navigation / chrome are skipped.
        if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
        const name = txt(el.getAttribute("aria-label")) || txt((el as HTMLElement).innerText);
        if (!name || navRe.test(name) || name.length > 120) continue;
        if (el.querySelector("input[type=file]")) continue; // a styled drop zone: the file input itself is recorded
        out.push({ ...base, kind: "button", inputType: "button", label: name, required: false, optionalHint: false, requiredHint: false });
      }
    }
    const cont = deepAll(document, "button,[role=button],input[type=submit]").find(
      (b) => shown(b) && /^(continue|next)$/i.test(txt(b.getAttribute("aria-label")) || txt((b as HTMLElement).innerText) || txt((b as HTMLInputElement).value)),
    ) as HTMLButtonElement | undefined;
    const continueDisabled = !!cont && (cont.disabled || cont.getAttribute("aria-disabled") === "true");
    return { controls: out, continueDisabled };
  }, NAV_BUTTON_RE.source);
  return { title: stepTitle, fields: controlsToFields(raw.controls, raw.continueDisabled, stepTitle) };
}

const quote = (s: string) => JSON.stringify(s);

function isDateInput(c: RawControl) {
  return c.inputType === "date" || /^[MD]{1,2}\/[MD]{1,2}\/Y{2,4}$/i.test(c.placeholder) || /^(mm|dd)[/.-](dd|mm)[/.-]yyyy$/i.test(c.placeholder);
}

/** Pure mapping from in-page control descriptions to FormFields (exported for tests). */
export function controlsToFields(controls: RawControl[], continueDisabled: boolean, step: string): FormField[] {
  const fields: FormField[] = [];
  const req = (c: RawControl) => !c.optionalHint && (c.required || c.requiredHint);
  const choices = controls.filter((c) => c.kind === "button");
  const pickers = controls.filter((c) => c.kind === "picker");
  // Pickers that belong to a date input's date/time widget (hour / minute / am-pm) collapse into one "time" field.
  const dateCtl = controls.find((c) => c.kind === "input" && isDateInput(c));
  const timePickers = dateCtl
    ? pickers.filter((c) => (dateCtl.label && c.label === dateCtl.label) || /\btime\b|^(hour|minute|am\/?pm)\b/i.test(c.label) || /^[:\s]*$/.test(c.label) || /\b(when|time)\b/i.test(c.boxText))
    : [];
  for (const c of controls) {
    if (c.kind === "button" || timePickers.includes(c)) continue;
    let type: FormFieldType = "unknown";
    let selectorHint: string | undefined;
    if (c.kind === "textarea") {
      type = "textarea";
      selectorHint = c.label ? `role=textbox[name=${quote(c.label)}]` : "textarea";
    } else if (c.kind === "input") {
      type = isDateInput(c) ? "date" : c.inputType === "time" ? "time" : "text";
      selectorHint = type === "date" && c.placeholder ? `[placeholder=${quote(c.placeholder)}]` : c.label ? `role=textbox[name=${quote(c.label)}]` : `input[type=${c.inputType}]`;
    } else if (c.kind === "select") {
      type = "select";
      selectorHint = c.label ? `role=combobox[name=${quote(c.label)}]` : "select";
    } else if (c.kind === "picker") {
      type = "select";
      selectorHint = `button[aria-haspopup="listbox"] >> nth=${pickers.indexOf(c)}`;
    } else if (c.kind === "radio") {
      type = "radio";
      selectorHint = c.group ? `input[type=radio][name=${quote(c.group)}]` : `role=radio[name=${quote(c.label)}]`;
    } else if (c.kind === "checkbox") {
      type = "checkbox";
      selectorHint = c.label ? `role=checkbox[name=${quote(c.label)}]` : "input[type=checkbox]";
    } else if (c.kind === "file") {
      type = "file";
      selectorHint = "input[type=file]";
    }
    const f: FormField = { label: c.label || "(unlabeled)", type, required: req(c), step };
    if (c.options.length) f.options = c.options.slice(0, 200);
    if (type === "text" || type === "textarea") f.maxLength = c.maxLength;
    if (selectorHint) f.selectorHint = selectorHint;
    fields.push(f);
  }
  if (timePickers.length) {
    const dateIdx = fields.findIndex((f) => f.type === "date");
    const time: FormField = { label: dateCtl?.label ? `${dateCtl.label} (time)` : "Time", type: "time", required: timePickers.some(req), step, selectorHint: `button[aria-haspopup="listbox"] >> nth=${pickers.indexOf(timePickers[0]!)}` };
    fields.splice(dateIdx + 1, 0, time);
  }
  if (choices.length >= 2) {
    fields.unshift({ label: step, type: "button-choice", required: continueDisabled, options: choices.map((c) => c.label).slice(0, 200), step, selectorHint: "role=button[name=<option>]" });
  }
  return fields;
}

/** Merge one observed step into the run's schema (same title ⇒ replaced in place, else appended). */
export function mergeFormStep(schema: FormSchema | null, step: FormStepSchema): FormSchema {
  const steps = [...(schema?.steps ?? [])];
  const i = steps.findIndex((s) => s.title === step.title);
  if (i >= 0) steps[i] = step;
  else steps.push(step);
  return { steps, capturedAt: nowIso() };
}

/**
 * Capture the current step, merge it into ctx.state.formSchema and emit
 * `EVT {"step":"inspect","message":"form_schema","data":{stepTitle,fields}}`. Never throws: observing must not break a filing.
 * `augment` lets an adapter refine the generic capture (relabel a picker, attach options it read itself).
 */
export async function recordFormSchema(ctx: AdapterContext, stepTitle: string, augment?: (fields: FormField[]) => FormField[]): Promise<FormStepSchema | null> {
  try {
    const captured = await captureFormSchema(ctx.page, stepTitle);
    return emitFormStep(ctx, { title: captured.title, fields: augment ? augment(captured.fields) : captured.fields });
  } catch (err) {
    ctx.log("inspect", "warn", `form_schema capture failed for "${stepTitle}": ${String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 160)}`);
    return null;
  }
}

/** Refine an already-recorded step (e.g. picker options read after opening it) and re-emit it. No-op if absent. */
export function updateFormStep(ctx: AdapterContext, stepTitle: string, update: (fields: FormField[]) => FormField[]) {
  const cur = ctx.state.formSchema?.steps.find((s) => s.title === stepTitle);
  if (cur) emitFormStep(ctx, { title: stepTitle, fields: update(cur.fields) });
}

/** Merge a step into ctx.state.formSchema and emit its `form_schema` event (no capture; adapters that list fields themselves). */
export function emitFormStep(ctx: AdapterContext, step: FormStepSchema): FormStepSchema {
  ctx.state.formSchema = mergeFormStep(ctx.state.formSchema, step);
  ctx.log("inspect", "info", "form_schema", { stepTitle: step.title, fields: step.fields });
  return step;
}

// ---------------------------------------------------------------------------
// extraFields (issue #12): resident answers to learned required fields, keyed by the official label
// ---------------------------------------------------------------------------

/** Label → comparable form (same rule as the hand-off / recipe adapters, fields.ts `normLabel`). */
export const normalizeLabel = normLabel;

/** The resident's answer for a form label: exact label first, then normalised. No fuzzy match here (generic matching is #9). */
export function matchExtraField(extra: Record<string, string> | undefined, label: string): { key: string; value: string } | null {
  if (!extra || !label.trim()) return null;
  const exact = extra[label];
  if (exact?.trim()) return { key: label, value: exact.trim() };
  const want = normalizeLabel(label);
  if (!want) return null;
  for (const [k, v] of Object.entries(extra)) if (v?.trim() && normalizeLabel(k) === want) return { key: k, value: v.trim() };
  return null;
}

/** Fill the input with this exact accessible label. False when the page has no such input (nothing typed). */
export async function fillByLabel(page: Page, label: string, value: string): Promise<boolean> {
  const box = page.getByLabel(label, { exact: true }).first();
  if (!(await box.count())) return false;
  await box.fill(value);
  return true;
}
