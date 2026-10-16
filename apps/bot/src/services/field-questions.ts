/**
 * Ask-before-approval from LEARNED required fields (issue #12, epic #10).
 *
 * #11 learns, per category, what the official form looks like (`FormSchema`) and which labels it requires
 * (`requiredFields`). Before the approval card the orchestrator asks the resident, one plain-language question at a
 * time, for every required field the draft cannot already answer:
 *
 *  - known fields map onto what intake already collects (transit line/direction/station/time, description, location,
 *    resident name + email) and are never asked here (the existing transit/location questions own them);
 *  - fields the category's own adapter drives (the MTA wizard's fixed topic path) are never asked;
 *  - fields only an official record holds (account / ID numbers — `UNKNOWABLE`) are never asked or guessed: the
 *    resident is told and the filing worker hands that part over (hand-off path);
 *  - everything else is asked and the answer lands in `draft.extraFields[<official label>]`.
 *
 * The question text is the official label rewritten by the LLM ONCE per (category, label) and cached as SEMANTIC memory
 * (`kind:"semantic", data:{label, question}`), so it costs one LLM call per label ever. No LLM ⇒ a deterministic
 * fallback ("The official form needs: <label>. What should I put?"). Option labels come from the form itself and are
 * rendered as inline buttons (`set_field:<id>:<version>:<fieldIndex>:<optionIndex>`); typed answers work too.
 *
 * Nothing here invents a value: every stored answer is a resident's own words or an option the form offers.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentMemory, ComplaintDraft, FormField, FormSchema, OutboundButton, Resident, Store } from "../core/contracts.js";
import { encodeCallback, nowIso } from "../core/contracts.js";
import { getCategory, mtaDirectionOptions, nycIso, requiredFieldsFor } from "../core/knowledge.js";
import { chatJson, type ChatMessage } from "../integrations/openrouter.js";
import { esc } from "../telegram/messages.js";

// ---------------------------------------------------------------------------
// field mapping
// ---------------------------------------------------------------------------
export type FieldTarget =
  | { kind: "transit"; key: "line" | "direction" | "station" | "incidentTime" }
  | { kind: "description" }
  | { kind: "location" }
  | { kind: "resident"; key: "contactName" | "contactEmail" }
  /** Driven by the category's own worker adapter (fixed wizard path); never a resident question. */
  | { kind: "adapter" }
  | { kind: "extra" };

/** Labels a category's adapter answers itself (MTA: the fixed topic path Subways › Complaint › Service › Delay). */
export const ADAPTER_OWNED: Record<string, RegExp> = {
  "subway-delay": /^(which service\?|i have a…|i have a\.\.\.|related to…|related to\.\.\.|about…|about\.\.\.|additional information)$/i,
};

/** Required fields only an official record holds: say so and hand off, never ask a guess, never fill. */
export const UNKNOWABLE = /\b(account|acct|policy|member|meter|permit|tax|social security)\s*(number|no\.?|#|id)\b|\b(ssn|ein|bbl|bin)\b|\bid\s*(number|no\.?|#)\b/i;

export function mapField(category: string | null, label: string): FieldTarget {
  const l = label.trim();
  if (category && ADAPTER_OWNED[category]?.test(l)) return { kind: "adapter" };
  const transit = requiredFieldsFor(category as never).includes("transit");
  if (/^first name|^last name|^full name|^(your )?name\b/i.test(l)) return { kind: "resident", key: "contactName" };
  if (/e-?mail/i.test(l)) return { kind: "resident", key: "contactEmail" };
  if (/tell us more|^description|describe (the|your) (problem|issue)|^details$/i.test(l)) return { kind: "description" };
  if (transit) {
    if (/select the line|subway line|^line$|which line/i.test(l)) return { kind: "transit", key: "line" };
    if (/direction|\bbound\b/i.test(l)) return { kind: "transit", key: "direction" };
    if (/station/i.test(l)) return { kind: "transit", key: "station" };
    if (/when did (this|it) happen|^date|^time|^hour$|^minute$|^am\/pm$/i.test(l)) return { kind: "transit", key: "incidentTime" };
  } else if (/^(incident |street )?address$|^location$|^where\b/i.test(l)) return { kind: "location" };
  return { kind: "extra" };
}

export type LearnedField = {
  /** Stable index into `learnedFields()` (the button callback carries it). */
  index: number;
  label: string;
  type: FormField["type"];
  /** Required by the form (skip not allowed). Listed in requiredFields but optional on the form ⇒ asked, skippable. */
  required: boolean;
  options?: string[];
  maxLength?: number | null;
  step: string | null;
  target: FieldTarget;
  unknowable: boolean;
};

/**
 * The fields to ask about, in form order: every label in `requiredFields` (catalog row / procedural memory) plus every
 * field the schema marks required. Labels in requiredFields the schema never showed come last (type unknown).
 */
export function learnedFields(category: string | null, schema: FormSchema | null | undefined, requiredFields: string[] | null | undefined): LearnedField[] {
  const wanted = new Set(requiredFields ?? []);
  const out: LearnedField[] = [];
  const seen = new Set<string>();
  const push = (f: Omit<LearnedField, "index" | "target" | "unknowable">) => {
    if (seen.has(f.label)) return;
    seen.add(f.label);
    out.push({ ...f, index: out.length, target: mapField(category, f.label), unknowable: UNKNOWABLE.test(f.label) });
  };
  for (const s of schema?.steps ?? []) {
    for (const f of s.fields) {
      if (!f.required && !wanted.has(f.label)) continue;
      push({ label: f.label, type: f.type, required: f.required, ...(f.options?.length ? { options: f.options } : {}), maxLength: f.maxLength ?? null, step: s.title });
    }
  }
  for (const label of wanted) push({ label, type: "unknown", required: true, step: null });
  return out;
}

/** What the draft / resident already has for a field (null ⇒ still missing). */
export function learnedValue(f: LearnedField, draft: ComplaintDraft, resident: Pick<Resident, "contactName" | "contactEmail">): string | null {
  const t = f.target;
  switch (t.kind) {
    case "transit":
      return draft.transit?.[t.key] ?? null;
    case "description":
      return draft.description || null;
    case "location":
      return draft.location.address ?? (draft.location.latitude != null ? `${draft.location.latitude},${draft.location.longitude}` : null);
    case "resident":
      return resident[t.key] ?? null;
    case "adapter":
      return "(adapter)";
    case "extra":
      return draft.extraFields?.[f.label]?.trim() || null;
  }
}

/**
 * The questions to ask now, in order: extra fields (and required resident name/email) still empty, not unknowable,
 * not already asked-and-skipped (`done`). Transit/location/description are owned by the existing intake questions.
 */
export function missingLearnedFields(fields: LearnedField[], draft: ComplaintDraft, resident: Pick<Resident, "contactName" | "contactEmail">, done: (label: string) => boolean = () => false): LearnedField[] {
  return fields.filter((f) => (f.target.kind === "extra" || (f.target.kind === "resident" && f.required)) && !f.unknowable && !done(f.label) && !learnedValue(f, draft, resident));
}

/** Required fields only an official record holds (told once, then handed off). */
export const unknowableFields = (fields: LearnedField[], draft: ComplaintDraft) => fields.filter((f) => f.unknowable && f.target.kind === "extra" && !draft.extraFields?.[f.label]);

/** Learned direction options for this line (the form's own aria-labels, `A Train-Uptown (…)`), prefix stripped; null ⇒ use the table. */
export function learnedDirectionOptions(schema: FormSchema | null | undefined, line: string | null | undefined): string[] | null {
  if (!schema || !line) return null;
  const field = schema.steps.flatMap((s) => s.fields).find((f) => /direction/i.test(f.label) && f.options && f.options.length >= 2);
  if (!field?.options) return null;
  const prefixes = [`${line} Train-`, `${line} train-`, `${line}-`];
  const stripped = field.options.map((o) => {
    const p = prefixes.find((x) => o.startsWith(x));
    return p ? o.slice(p.length).trim() : null;
  });
  // Options captured for a different line (the merged schema keeps the latest run's) are not this line's options.
  if (stripped.some((o) => !o)) return null;
  return stripped as string[];
}

/** Direction options for the question + buttons: learned from the form when present, else the hardcoded table. */
export function directionOptionsFor(schema: FormSchema | null | undefined, line: string | null | undefined): string[] | null {
  return learnedDirectionOptions(schema, line) ?? mtaDirectionOptions(line);
}

// ---------------------------------------------------------------------------
// plain-language phrasing (LLM once per label, cached as semantic memory)
// ---------------------------------------------------------------------------
export const FieldQuestion = z.object({
  question: z.string().min(3).max(240),
  kind: z.enum(["text", "choice", "date", "time"]),
  helper: z.string().max(200).nullable(),
});
export type FieldQuestion = z.infer<typeof FieldQuestion>;
export type PhrasedQuestion = FieldQuestion & { source: "memory" | "llm" | "fallback" };

export type FieldRewriter = (input: { category: string; categoryLabel: string; label: string; type: string; options: string[] }) => Promise<FieldQuestion>;

export const fieldQuestionMemoryId = (category: string, label: string) => `mem_fieldq_${category}_${createHash("sha1").update(label).digest("hex").slice(0, 12)}`;

export function kindFor(f: Pick<LearnedField, "type" | "options">): FieldQuestion["kind"] {
  if (f.options?.length) return "choice";
  if (f.type === "date") return "date";
  if (f.type === "time") return "time";
  return "text";
}

/** Deterministic phrasing (no LLM). */
export function fallbackQuestion(f: Pick<LearnedField, "label" | "type" | "options">): FieldQuestion {
  return { question: `The official form needs: ${f.label}. What should I put?`, kind: kindFor(f), helper: null };
}

const SYSTEM = [
  "You rewrite one field label from an official New York City complaint form into ONE short, friendly, plain-language question for a resident chatting with a helper bot.",
  "Rules: ask only for that one field; keep the meaning exact; no jargon, no field codes; never include an example value that could be mistaken for the answer; under 20 words; end with a question mark.",
  "kind: \"choice\" when the form offers options, \"date\" for a date, \"time\" for a time of day, else \"text\".",
  "helper: at most one short hint about format (e.g. \"today is fine\", \"MM/DD/YYYY\"), or null.",
  'Examples: "Nearest cross street" → "What\'s the nearest cross street?"; "Date Detected (MM/DD/YYYY)" → "When did you notice it?" (kind date, helper "today is fine").',
].join("\n");

/** The default LLM rewriter (OpenRouter, strict JSON schema). Null when no key is configured. */
export function openRouterRewriter(): FieldRewriter | null {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
  return async ({ categoryLabel, label, type, options }) => {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ form: categoryLabel, label, controlType: type, options: options.slice(0, 12) }) },
    ];
    const res = await chatJson(FieldQuestion, messages, { model, maxTokens: 200, schemaName: "field_question", timeoutMs: 15_000 });
    return res.data;
  };
}

export type FieldPhraser = {
  phrase(category: string, f: Pick<LearnedField, "label" | "type" | "options">): Promise<PhrasedQuestion>;
};

/**
 * Lookup order: in-process cache → semantic memory (`mem_fieldq_<category>_<hash>`) → LLM (then remembered) →
 * deterministic fallback (kept in-process only, so a later run with the LLM back still gets a better question).
 */
export function createFieldPhraser(deps: { store: Store; memory?: Pick<AgentMemory, "remember"> | null; rewrite?: FieldRewriter | null }): FieldPhraser {
  const cache = new Map<string, PhrasedQuestion>();
  const rewrite = deps.rewrite === undefined ? openRouterRewriter() : deps.rewrite;
  return {
    async phrase(category, f) {
      const id = fieldQuestionMemoryId(category, f.label);
      const hit = cache.get(id);
      if (hit) return hit;
      const rows = (await deps.store.listMemory?.({ kind: "semantic", category, limit: 500 }).catch(() => [])) ?? [];
      const row = rows.find((r) => r.id === id);
      const d = row?.data as Partial<FieldQuestion & { label: string }> | undefined;
      if (d?.label === f.label && typeof d.question === "string" && d.question.trim()) {
        const q: PhrasedQuestion = { question: d.question, kind: f.options?.length ? "choice" : (FieldQuestion.shape.kind.safeParse(d.kind).data ?? kindFor(f)), helper: d.helper ?? null, source: "memory" };
        cache.set(id, q);
        return q;
      }
      if (rewrite) {
        try {
          const label = getCategory(category as never)?.label ?? category;
          const out = FieldQuestion.parse(await rewrite({ category, categoryLabel: label, label: f.label, type: f.type, options: f.options ?? [] }));
          const q: PhrasedQuestion = { question: out.question.trim(), kind: f.options?.length ? "choice" : out.kind === "choice" ? kindFor(f) : out.kind, helper: out.helper?.trim() || null, source: "llm" };
          cache.set(id, q);
          if (deps.memory)
            await deps.memory
              .remember({
                id,
                kind: "semantic",
                text: `Plain-language question for the ${label} form field "${f.label}": ${q.question}`,
                category,
                chatId: null,
                importance: 0.4,
                data: { label: f.label, question: q.question, kind: q.kind, helper: q.helper, learnedAt: nowIso() },
                source: "llm:field_question",
                about: [{ table: "complaint_category", id: category }],
              })
              .catch((e) => console.warn("[field-questions] remember failed:", (e as Error).message));
          return q;
        } catch (err) {
          console.warn("[field-questions] LLM rewrite unavailable, using fallback phrasing:", (err as Error).message);
        }
      }
      const q: PhrasedQuestion = { ...fallbackQuestion(f), source: "fallback" };
      cache.set(id, q);
      return q;
    },
  };
}

// ---------------------------------------------------------------------------
// prompt, buttons, answers
// ---------------------------------------------------------------------------
export const MAX_OPTION_BUTTONS = 8;
export const WHY_REPLY = "The official form requires it.";

export function fieldPrompt(f: LearnedField, q: Pick<FieldQuestion, "question" | "helper">): string {
  const lead = `📝 <i>The official form asks for “${esc(f.label)}”.</i>`;
  const opts = f.options && f.options.length > MAX_OPTION_BUTTONS ? `\n${f.options.map((o, i) => `${i + 1}. ${esc(o)}`).join("\n")}` : "";
  const helper = q.helper ? `\n<i>${esc(q.helper)}</i>` : "";
  const how = f.options?.length ? (f.options.length > MAX_OPTION_BUTTONS ? "Reply with the number or the option" : "Tap an option or type it") : "Type your answer";
  return `${lead}\n\n<b>${esc(q.question)}</b>${helper}${opts}\n\n<i>${how}${f.required ? "" : ", or “skip” (it's optional)"}.</i>`;
}

export function fieldButtons(d: Pick<ComplaintDraft, "id" | "draftVersion">, f: LearnedField, kind: FieldQuestion["kind"]): OutboundButton[][] {
  const data = (suffix: string) => `${encodeCallback("set_field", d.id, d.draftVersion)}:${f.index}:${suffix}`;
  const rows: OutboundButton[][] = [];
  if (f.options?.length && f.options.length <= MAX_OPTION_BUTTONS) f.options.forEach((o, i) => rows.push([{ text: o, data: data(String(i)) }]));
  if (!f.options?.length && kind === "date") rows.push([{ text: "Today", data: data("t") }]);
  if (!f.required) rows.push([{ text: "Skip (optional)", data: data("s") }]);
  return rows;
}

/** Parse `set_field:<id>:<v>:<fieldIndex>:<optionIndex|t|s>`. */
export function parseFieldCallback(data: string): { index: number; choice: number | "today" | "skip" } | null {
  const [, , , fi, ch] = data.split(":");
  const index = Number(fi);
  if (!Number.isInteger(index) || index < 0 || ch == null) return null;
  if (ch === "t") return { index, choice: "today" };
  if (ch === "s") return { index, choice: "skip" };
  const o = Number(ch);
  return Number.isInteger(o) && o >= 0 ? { index, choice: o } : null;
}

/** Today in New York in the form's own date format (MM/DD/YYYY unless the label asks for ISO). */
export function todayFor(label: string, iso = nycIso()): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return /yyyy-mm-dd/i.test(label) ? `${y}-${m}-${d}` : `${m}/${d}/${y}`;
}

export type FieldAnswer =
  | { kind: "value"; value: string }
  | { kind: "resident"; patch: { contactName?: string; contactEmail?: string } }
  | { kind: "skip" }
  | { kind: "why" }
  | { kind: "invalid"; message: string };

const SKIP = /^(skip|no|not sure|don'?t know|idk|dunno|unknown|n\/a|none)\b/i;
const WHY = /^(why|how come|what for|why do you (need|want)|why are you asking)\b/i;

export function parseFieldAnswer(f: LearnedField, text: string): FieldAnswer {
  const max = Math.min(Math.max(f.maxLength ?? 500, 1), 1000);
  const v = text.trim().replace(/\s+/g, " ");
  if (WHY.test(v)) return { kind: "why" };
  if (!v || SKIP.test(v)) return f.required ? { kind: "invalid", message: `${WHY_REPLY} I can't leave it out, so I need an answer.` } : { kind: "skip" };
  if (f.target.kind === "resident") {
    if (f.target.key === "contactName")
      return v.split(" ").length >= 2 && v.length <= 80 ? { kind: "resident", patch: { contactName: v } } : { kind: "invalid", message: "Please send a first and last name, like <code>Jane Doe</code>." };
    return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(v) ? { kind: "resident", patch: { contactEmail: v } } : { kind: "invalid", message: "That doesn't look like an email. Try again." };
  }
  if (f.options?.length) {
    const byIndex = /^\d{1,3}$/.test(v) ? f.options[Number(v) - 1] : undefined;
    const lower = v.toLowerCase();
    const exact = byIndex ?? f.options.find((o) => o.toLowerCase() === lower);
    const partial = exact ? [] : f.options.filter((o) => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
    const pick = exact ?? (partial.length === 1 ? partial[0] : undefined);
    if (!pick) return { kind: "invalid", message: `Please pick one of the form's options: ${f.options.map((o) => `“${esc(o)}”`).join(", ")}.` };
    return { kind: "value", value: pick };
  }
  if (kindFor(f) === "date" || /\bdate\b/i.test(f.label)) {
    if (/^(today|just now|now)\b/i.test(v)) return { kind: "value", value: todayFor(f.label) };
    if (/^yesterday\b/i.test(v)) return { kind: "value", value: todayFor(f.label, nycIso(new Date(Date.now() - 86_400_000))) };
  }
  return { kind: "value", value: v.slice(0, max) };
}

/** Card lines: "What the form needs" (answers given, and fields the resident fills on the official form). */
export function formNeedsLines(fields: LearnedField[], draft: ComplaintDraft): string[] {
  const rows = fields.filter((f) => f.target.kind === "extra");
  const given = rows.filter((f) => draft.extraFields?.[f.label]);
  const handoff = rows.filter((f) => f.unknowable && !draft.extraFields?.[f.label]);
  if (!given.length && !handoff.length) return [];
  return [
    "<b>What the form needs:</b>",
    ...given.map((f) => `• ${esc(f.label)}: ${esc(draft.extraFields![f.label]!)}`),
    ...handoff.map((f) => `• ${esc(f.label)}: <i>you'll enter this yourself on the official form</i>`),
  ];
}

export function unknowableNotice(fields: LearnedField[]): string {
  const list = fields.map((f) => `“${esc(f.label)}”`).join(", ");
  return `ℹ️ The official form also needs ${list}. That comes from your own records, so I won't guess it. When I file, I'll hand you the official form to fill that part in yourself.`;
}
