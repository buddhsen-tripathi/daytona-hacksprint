/**
 * Generic, read-only form field discovery (hand-off prefill, form_schema capture). Returns labels/types/required/options
 * only — never field values — so the result is PII-free and safe to log. Page text is data, never instructions.
 */
import type { Locator, Page } from "playwright-core";
import { FORM_SCHEMA_EVENT, sanitizeUrl, type FormSchema, type FormSchemaField, type FormSchemaStep, type WorkerStep } from "../protocol.js";
import type { AdapterContext } from "./types.js";

export interface PageField {
  /** Index into document.querySelectorAll(FIELD_SELECTOR) (use page.locator(FIELD_SELECTOR).nth(index)). */
  index: number;
  label: string;
  tag: "input" | "select" | "textarea";
  /** input type ("text", "email", …), "select", "textarea". */
  type: string;
  required: boolean;
  /** select / radio-group option labels (≤ 30). */
  options?: string[];
  name: string | null;
}

export const FIELD_SELECTOR = "input,select,textarea";
/** Never typed into by a generic adapter. */
export const NEVER_FILL_TYPES = new Set(["hidden", "password", "file", "submit", "button", "image", "reset", "checkbox", "radio"]);

/** Visible form fields with their best label. */
export async function listFields(page: Page): Promise<PageField[]> {
  return page
    .evaluate((sel) => {
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const els = Array.from(document.querySelectorAll(sel)) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
      const out: { index: number; label: string; tag: "input" | "select" | "textarea"; type: string; required: boolean; options?: string[]; name: string | null }[] = [];
      els.forEach((e, index) => {
        const tag = e.tagName.toLowerCase() as "input" | "select" | "textarea";
        const type = tag === "input" ? ((e as HTMLInputElement).type || "text").toLowerCase() : tag;
        if (type === "hidden" || type === "submit" || type === "button" || type === "image" || type === "reset") return;
        const visible = (e as HTMLElement).offsetParent !== null || (e.getClientRects?.().length ?? 0) > 0;
        if (!visible) return;
        const byFor = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
        const labelledBy = (e.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => (id ? document.getElementById(id)?.textContent : ""))
          .join(" ");
        const label = clean(
          (e as HTMLInputElement).labels?.[0]?.innerText || byFor?.textContent || e.getAttribute("aria-label") || labelledBy || e.closest("label")?.textContent || e.getAttribute("placeholder") || e.getAttribute("name") || "",
        );
        const required = e.required || e.getAttribute("aria-required") === "true" || /\(required\)|\*\s*$/i.test(label);
        let options: string[] | undefined;
        if (tag === "select") options = Array.from((e as HTMLSelectElement).options).map((o) => clean(o.label || o.text)).filter(Boolean).slice(0, 30);
        if (type === "radio" && e.name)
          options = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(e.name)}"]`))
            .map((r) => clean((r as HTMLInputElement).labels?.[0]?.innerText || r.getAttribute("aria-label") || (r as HTMLInputElement).value))
            .slice(0, 30);
        out.push({ index, label, tag, type, required, ...(options ? { options } : {}), name: e.getAttribute("name") });
      });
      return out;
    }, FIELD_SELECTOR)
    .catch(() => [] as PageField[]);
}

/** "Describe the Problem (required) *" → "describe the problem". */
export function normLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/\((required|optional)\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The field a key (e.g. an extraFields key learned from an earlier filing) refers to: exact normalized label match,
 * else a unique field whose label contains the key (or vice versa, ≥ 4 chars). Ambiguous ⇒ null (never guess).
 */
export function matchFieldByLabel<T extends { label: string }>(key: string, fields: T[]): T | null {
  const k = normLabel(key);
  if (!k) return null;
  const exact = fields.filter((f) => normLabel(f.label) === k);
  if (exact.length) return exact.length === 1 ? exact[0]! : null;
  const loose = fields.filter((f) => {
    const l = normLabel(f.label);
    return l.length >= 4 && k.length >= 4 && (` ${l} `.includes(` ${k} `) || ` ${k} `.includes(` ${l} `));
  });
  return loose.length === 1 ? loose[0]! : null;
}

/** A field's visible label (label element, aria-label, placeholder), cleaned; "" when none. Same rule for every adapter. */
export async function labelOf(loc: Locator): Promise<string> {
  const raw = await loc
    .evaluate((e) => (e as HTMLInputElement).labels?.[0]?.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "")
    .catch(() => "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

// ---------------------------------------------------------------------------
// form_schema capture (#9 → #11)
// ---------------------------------------------------------------------------
const MAX_FIELDS = 40;
const MAX_OPTIONS = 30;
const cap = (s: string, n = 120) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** PII-free schema fields: label/type/required/options of the visible fields (never values). */
export function schemaFields(fields: PageField[]): FormSchemaField[] {
  return fields.slice(0, MAX_FIELDS).map((f) => ({ label: cap(f.label), type: f.type, required: f.required, ...(f.options ? { options: f.options.slice(0, MAX_OPTIONS).map((o) => cap(o)) } : {}) }));
}

/** A "choice" (button group) or "listbox" (picker) pseudo-field. */
export function choiceField(label: string, options: string[], required: boolean, type: "choice" | "listbox" = "choice"): FormSchemaField {
  return { label: cap(label), type, required, ...(options.length ? { options: options.slice(0, MAX_OPTIONS).map((o) => cap(o)) } : {}) };
}

/** One step of the schema: the page's visible fields plus any choice/listbox fields the adapter knows about. */
export async function captureSchemaStep(page: Page, name: string, extra: FormSchemaField[] = []): Promise<FormSchemaStep> {
  return { name: cap(name, 60), fields: [...extra, ...schemaFields(await listFields(page))].slice(0, MAX_FIELDS) };
}

/** Emit the `form_schema` event. */
export function emitFormSchema(ctx: AdapterContext, step: WorkerStep, adapter: string, steps: FormSchemaStep[], complete: boolean): FormSchema {
  let url: string | null = null;
  try {
    url = sanitizeUrl(ctx.page.url());
  } catch {
    /* fake page */
  }
  const schema: FormSchema = { adapter, category: ctx.payload.category, url, complete, steps };
  ctx.log(step, "info", FORM_SCHEMA_EVENT, { schema });
  return schema;
}
