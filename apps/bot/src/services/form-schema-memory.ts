/**
 * Learned form schemas (issue #11, epic #10): after every filing attempt whose worker reported a
 * `formSchema`, write what the official form looked like into procedural memory, per category.
 *
 *   mem_schema_<category>        the CURRENT merged schema (upserted): union of required fields over every
 *                                observation, latest options, `history: [{attemptId, capturedAt, outcome, diff}]`
 *   mem_schemahist_<attemptId>   one append-only item per observation (that run's schema + its diff)
 *
 * and mirror the merged result onto the catalog row (`complaint_category.requiredFields / formSchema /
 * lastVerifiedAt`) via `Store.updateCategorySchema`.
 *
 * STRUCTURE ONLY. `sanitizeFormSchema` rebuilds every field from an allowlist (label, type, required, options,
 * maxLength, step, selectorHint), so a stray `value` / `checked` / `filled` key from a worker never reaches
 * memory, the catalog or a span; options are kept only for choice controls (a text box has no options, so
 * anything there would be a typed value); every string goes through `scrubPii`.
 */
import type { AgentMemory, CatalogEntry, Evidence, FilingAttempt, FilingStatus, FormField, FormSchema, MemoryItem, MemoryRecord, Store } from "../core/contracts.js";
import { FormFieldType } from "../core/contracts.js";
import { getCategory } from "../core/knowledge.js";
import { scrubPii } from "./agent-memory.js";

export const schemaMemoryId = (category: string) => `mem_schema_${category}`;
export const schemaHistoryMemoryId = (attemptId: string) => `mem_schemahist_${attemptId}`;
/** History entries kept on the current item (the append-only items keep everything). */
export const SCHEMA_HISTORY_MAX = 50;

const CHOICE_TYPES = new Set<FormField["type"]>(["select", "radio", "button-choice", "checkbox"]);
const MAX_STEPS = 40;
const MAX_FIELDS_PER_STEP = 40;
const MAX_OPTIONS = 200;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? scrubPii(v).slice(0, max) : "");
/** A selector hint that pins a value (`[value="…"]`, `:has-text("…")` on an input) is not structure. */
const VALUE_IN_SELECTOR = /\bvalue\s*[=~*^$|]|:has-text|:text\(|@/i;

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
function sanitizeField(raw: unknown, stepTitle: string): FormField | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const label = clean(f.label);
  if (!label) return null;
  const t = FormFieldType.safeParse(f.type);
  const type = t.success ? t.data : "unknown";
  const out: FormField = { label, type, required: f.required === true, step: clean(f.step) || stepTitle };
  if (CHOICE_TYPES.has(type) && Array.isArray(f.options)) {
    const opts = [...new Set(f.options.map((o) => clean(o)).filter(Boolean))].slice(0, MAX_OPTIONS);
    if (opts.length) out.options = opts;
  }
  if (typeof f.maxLength === "number" && Number.isFinite(f.maxLength) && f.maxLength > 0) out.maxLength = Math.floor(f.maxLength);
  else if (f.maxLength === null) out.maxLength = null;
  if (typeof f.selectorHint === "string" && !VALUE_IN_SELECTOR.test(f.selectorHint)) {
    const hint = clean(f.selectorHint, 300);
    if (hint) out.selectorHint = hint;
  }
  return out;
}

/** Structure-only copy of a worker-reported schema (null when nothing usable is left). */
export function sanitizeFormSchema(raw: unknown, fallbackCapturedAt = new Date().toISOString()): FormSchema | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { steps?: unknown }).steps)) return null;
  const r = raw as { steps: unknown[]; capturedAt?: unknown };
  const steps: FormSchema["steps"] = [];
  for (const s of r.steps.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== "object") continue;
    const title = clean((s as { title?: unknown }).title) || "(untitled step)";
    const rawFields = (s as { fields?: unknown }).fields;
    const fields = (Array.isArray(rawFields) ? rawFields : [])
      .slice(0, MAX_FIELDS_PER_STEP)
      .map((f) => sanitizeField(f, title))
      .filter((f): f is FormField => !!f);
    if (fields.length) steps.push({ title, fields });
  }
  if (!steps.length) return null;
  const capturedAt = typeof r.capturedAt === "string" && !Number.isNaN(Date.parse(r.capturedAt)) ? r.capturedAt : fallbackCapturedAt;
  return { steps, capturedAt };
}

/** Distinct labels of the required fields, in form order. */
export function requiredFieldsOf(schema: FormSchema): string[] {
  const out: string[] = [];
  for (const s of schema.steps) for (const f of s.fields) if (f.required && !out.includes(f.label)) out.push(f.label);
  return out;
}

export type SchemaDiff = {
  /** Fields seen for the first time in this run. */
  added: string[];
  /** Fields seen before but not in this run (kept in the merged schema). */
  notSeen: string[];
  /** Required in this run, not in the merged list before. */
  newlyRequired: string[];
  /** Choice controls whose option labels changed (latest wins). */
  optionsChanged: string[];
};

const fieldKey = (f: Pick<FormField, "step" | "label">) => `${f.step}\u0000${f.label}`;
const sameOptions = (a?: string[], b?: string[]) => (a ?? []).join("\u0000") === (b ?? []).join("\u0000");

/**
 * Merge one observation into the category's current schema: the latest run's step + field order and options win,
 * `required` is OR-ed (⇒ requiredFields is the union over runs), fields not seen this run are kept after it.
 */
export function mergeFormSchemas(prev: FormSchema | null, next: FormSchema): { merged: FormSchema; diff: SchemaDiff } {
  const diff: SchemaDiff = { added: [], notSeen: [], newlyRequired: [], optionsChanged: [] };
  if (!prev) {
    diff.added = next.steps.flatMap((s) => s.fields.map((f) => f.label));
    diff.newlyRequired = requiredFieldsOf(next);
    return { merged: structuredClone(next), diff };
  }
  const before = new Map(prev.steps.flatMap((s) => s.fields.map((f) => [fieldKey(f), f] as const)));
  const seen = new Set<string>();
  const steps: FormSchema["steps"] = [];
  const stepIndex = new Map<string, number>();
  for (const s of next.steps) {
    const fields = s.fields.map((f) => {
      const k = fieldKey(f);
      seen.add(k);
      const old = before.get(k);
      if (!old) diff.added.push(f.label);
      else if (CHOICE_TYPES.has(f.type) && !sameOptions(old.options, f.options)) diff.optionsChanged.push(f.label);
      return { ...f, required: f.required || !!old?.required };
    });
    stepIndex.set(s.title, steps.length);
    steps.push({ title: s.title, fields });
  }
  for (const s of prev.steps) {
    for (const f of s.fields) {
      if (seen.has(fieldKey(f))) continue;
      diff.notSeen.push(f.label);
      let i = stepIndex.get(s.title);
      if (i == null) {
        i = steps.length;
        stepIndex.set(s.title, i);
        steps.push({ title: s.title, fields: [] });
      }
      steps[i]!.fields.push({ ...f });
    }
  }
  const merged: FormSchema = { steps, capturedAt: next.capturedAt };
  const was = new Set(requiredFieldsOf(prev));
  diff.newlyRequired = requiredFieldsOf(merged).filter((l) => !was.has(l));
  return { merged, diff };
}

/** Compact, value-free summary for spans and memory text. */
export function schemaSummary(schema: FormSchema) {
  return {
    steps: schema.steps.map((s) => ({ title: s.title, fields: s.fields.map((f) => ({ label: f.label, type: f.type, required: f.required, options: f.options?.length ?? 0 })) })),
    requiredFields: requiredFieldsOf(schema),
    capturedAt: schema.capturedAt,
  };
}

const categoryLabel = (id: string) => getCategory(id as never)?.label ?? id;

export function schemaText(category: string, schema: FormSchema, requiredFields = requiredFieldsOf(schema)): string {
  return `Form schema for ${categoryLabel(category)}: steps ${schema.steps.map((s) => s.title).join(" → ")}; required fields: ${requiredFields.length ? requiredFields.join(", ") : "none observed"}.`;
}

// ---------------------------------------------------------------------------
// item builders (the only place schema memory text is composed)
// ---------------------------------------------------------------------------
export type SchemaSource = { attemptId: string; traceId: string | null; evidenceIds: string[]; capturedAt: string };
export type SchemaHistoryEntry = { attemptId: string; capturedAt: string; outcome: FilingStatus; diff: SchemaDiff };
export type CurrentSchemaData = {
  formSchema: FormSchema;
  requiredFields: string[];
  version: number;
  source: SchemaSource;
  outcome: FilingStatus;
  history: SchemaHistoryEntry[];
};

export type SchemaObservation = {
  category: string;
  attempt: Pick<FilingAttempt, "id" | "traceId"> & { evidence?: Pick<Evidence, "id" | "type" | "step">[] };
  outcome: FilingStatus;
  /** Raw worker-reported schema; sanitized here. */
  formSchema: unknown;
};

/** Confirm / validate screenshots of the attempt (where the schema can be checked by eye). */
export const schemaEvidenceIds = (evidence: Pick<Evidence, "id" | "type" | "step">[] = []) =>
  evidence.filter((e) => e.type === "screenshot" && (e.step === "confirm" || e.step === "validate")).map((e) => e.id);

export function formSchemaItems(obs: SchemaObservation, prev: CurrentSchemaData | null, observed: FormSchema): { current: MemoryItem; history: MemoryItem; data: CurrentSchemaData } {
  const { merged, diff } = mergeFormSchemas(prev?.formSchema ?? null, observed);
  const requiredFields = requiredFieldsOf(merged);
  const version = (prev?.version ?? 0) + 1;
  const source: SchemaSource = { attemptId: obs.attempt.id, traceId: obs.attempt.traceId ?? null, evidenceIds: schemaEvidenceIds(obs.attempt.evidence), capturedAt: observed.capturedAt };
  const entry: SchemaHistoryEntry = { attemptId: obs.attempt.id, capturedAt: observed.capturedAt, outcome: obs.outcome, diff };
  const data: CurrentSchemaData = { formSchema: merged, requiredFields, version, source, outcome: obs.outcome, history: [...(prev?.history ?? []), entry].slice(-SCHEMA_HISTORY_MAX) };
  const about = [{ table: "filing_attempt" as const, id: obs.attempt.id }, { table: "complaint_category" as const, id: obs.category }];
  const current: MemoryItem = {
    id: schemaMemoryId(obs.category),
    kind: "procedural",
    text: schemaText(obs.category, merged, requiredFields),
    category: obs.category,
    chatId: null,
    importance: obs.outcome === "SUBMITTED" ? 0.9 : 0.6,
    data: { ...data, current: true },
    source: `attempt:${obs.attempt.id}`,
    about,
  };
  const history: MemoryItem = {
    id: schemaHistoryMemoryId(obs.attempt.id),
    kind: "procedural",
    text: `Form schema observation (v${version}) for ${categoryLabel(obs.category)}: steps ${observed.steps.map((s) => s.title).join(" → ")}; required fields: ${requiredFieldsOf(observed).join(", ") || "none observed"}.`,
    category: obs.category,
    chatId: null,
    // history is for audit; the current item is what recall should surface
    importance: 0.3,
    data: { formSchema: observed, requiredFields: requiredFieldsOf(observed), version, source, outcome: obs.outcome, diff, current: false, currentId: schemaMemoryId(obs.category) },
    source: `attempt:${obs.attempt.id}`,
    about,
  };
  return { current, history, data };
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------
type SchemaRow = Pick<MemoryRecord, "id" | "data" | "createdAt">;

/** The current merged schema item for a category (null when none was learned yet). */
export async function readCurrentSchema(store: Store, category: string): Promise<CurrentSchemaData | null> {
  if (!store.listMemory) return null;
  const rows: SchemaRow[] = await store.listMemory({ kind: "procedural", category, about: { table: "complaint_category", id: category }, limit: 1000 });
  const row = rows.find((r) => r.id === schemaMemoryId(category));
  const d = row?.data as Partial<CurrentSchemaData> | undefined;
  if (!d?.formSchema) return null;
  const formSchema = sanitizeFormSchema(d.formSchema);
  if (!formSchema) return null;
  return {
    formSchema,
    requiredFields: Array.isArray(d.requiredFields) ? d.requiredFields : requiredFieldsOf(formSchema),
    version: typeof d.version === "number" ? d.version : 1,
    source: d.source as SchemaSource,
    outcome: d.outcome as FilingStatus,
    history: Array.isArray(d.history) ? d.history : [],
  };
}

/** One merge at a time per store + category (two filings finishing together must not lose an observation). */
const chains = new WeakMap<Store, Map<string, Promise<unknown>>>();
function serialized<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  let m = chains.get(store);
  if (!m) chains.set(store, (m = new Map()));
  const prev = m.get(key) ?? Promise.resolve();
  const p = prev.catch(() => {}).then(fn);
  const tail = p.catch(() => {});
  m.set(key, tail);
  void tail.then(() => {
    if (m!.get(key) === tail) m!.delete(key);
  });
  return p;
}

export type RecordedSchema = { currentId: string; historyId: string; version: number; requiredFields: string[]; diff: SchemaDiff; catalogUpdated: boolean };

/**
 * Persist one observation: merge with the category's current schema, upsert the current item, append the history
 * item, update the catalog row. Returns null when the worker reported nothing usable. Memory absent ⇒ catalog only.
 */
export function recordFormSchema(deps: { store: Store; memory?: Pick<AgentMemory, "remember"> | null }, obs: SchemaObservation): Promise<RecordedSchema | null> {
  const observed = sanitizeFormSchema(obs.formSchema);
  if (!observed) return Promise.resolve(null);
  const { store } = deps;
  return serialized(store, obs.category, async () => {
    const prev = await readCurrentSchema(store, obs.category);
    const { current, history, data } = formSchemaItems(obs, prev, observed);
    if (deps.memory) {
      await deps.memory.remember(history);
      await deps.memory.remember(current);
    }
    let catalogUpdated = false;
    if (store.updateCategorySchema) {
      await store.updateCategorySchema(obs.category, { requiredFields: data.requiredFields, formSchema: data.formSchema, lastVerifiedAt: observed.capturedAt });
      catalogUpdated = true;
    }
    return { currentId: current.id!, historyId: history.id!, version: data.version, requiredFields: data.requiredFields, diff: history.data!.diff as SchemaDiff, catalogUpdated };
  });
}

/** `GET /api/categories/:id/schema`: the merged schema with provenance; falls back to the catalog row (no provenance). */
export async function categorySchemaView(store: Store, category: string) {
  const cur = await readCurrentSchema(store, category);
  // #13: human-approved confirmRegex / questionText repairs for this category (null when none)
  const overrides = (await store.getCategoryOverrides?.(category).catch(() => null)) ?? null;
  if (cur) {
    return {
      category,
      requiredFields: cur.requiredFields,
      formSchema: cur.formSchema,
      version: cur.version,
      outcome: cur.outcome,
      provenance: { attemptId: cur.source?.attemptId ?? null, traceId: cur.source?.traceId ?? null, capturedAt: cur.source?.capturedAt ?? cur.formSchema.capturedAt, evidenceIds: cur.source?.evidenceIds ?? [] },
      history: cur.history,
      overrides,
      source: "memory" as const,
    };
  }
  const row: CatalogEntry | undefined = (await store.listCatalog?.().catch(() => []))?.find((e) => e.id === category);
  if (row?.formSchema) {
    return { category, requiredFields: row.requiredFields ?? requiredFieldsOf(row.formSchema), formSchema: row.formSchema, version: null, outcome: null, provenance: { attemptId: null, traceId: null, capturedAt: row.lastVerifiedAt, evidenceIds: [] }, history: [], overrides, source: "catalog" as const };
  }
  return null;
}
