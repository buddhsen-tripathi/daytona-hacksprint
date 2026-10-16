/**
 * Post-mortem self-repair (#13).
 *
 * After a failed/ambiguous filing attempt (runPostmortem, fired async by the orchestrator AFTER the outcome message)
 * we gather the evidence the run left behind (worker events, #11 form schema, screenshots, trace id, the category's
 * current required fields), ask the LLM for a strict-JSON diagnosis and store it as a `repair_proposal` row plus a
 * memory reflect() note. Proposals are NOT applied here: an operator approves them on the dashboard
 * (POST /api/repairs/:id/approve). The only exception is the deterministic guard below — a `requiredField`
 * addition with confidence >= 0.9 is auto-applied.
 *
 * Applying = `requiredField` only: the label is merged into the category's learned form schema through #11's path
 * (recordFormSchema → memory + Store.updateCategorySchema, which bumps lastVerifiedAt). `recipeStep` (#9),
 * `confirmRegex` and `questionText` changes stay proposal-only: approving records the decision but writes nothing,
 * and nothing that affects the submit step is ever applied automatically.
 */
import {
  REPAIR_AUTO_APPLY_CONFIDENCE,
  RepairDiagnosis,
  RepairProposal,
  shortId,
  type AgentMemory,
  type FilingAttempt,
  type FormSchema,
  type RepairChange,
  type Store,
  type Tracer,
  type WorkerEvent,
} from "../core/contracts.js";
import { chatJson, type ChatMessage } from "../integrations/openrouter.js";
import { readCurrentSchema, recordFormSchema, sanitizeFormSchema } from "./form-schema-memory.js";

export type { FormSchema };

/** FilingAttempt plus the optional #11 schema (WorkerResult.formSchema when the caller still has it). */
export type PostmortemAttempt = FilingAttempt & { formSchema?: FormSchema | null };

const TRIGGER_CODES: ReadonlyArray<string> = [
  "HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD",
  "SUBMISSION_UNKNOWN/NO_CONFIRMATION",
  "FAILED/FORM_REJECTED",
];

function askedLiveQuestion(events: WorkerEvent[]): boolean {
  return events.some((e) => e.message === "question");
}

/** A dry run that filled the form and stopped before Submit (HUMAN_ACTION_REQUIRED, no error code): nothing failed. */
export const isDryRunStop = (attempt: Pick<FilingAttempt, "outcome" | "errorCode">) => attempt.outcome === "HUMAN_ACTION_REQUIRED" && !attempt.errorCode;

/** Which outcomes trigger a post-mortem (issue #13 "Behaviour"). Dry-run stops never do, even after a live question. */
export function shouldPostmortem(attempt: FilingAttempt): boolean {
  if (isDryRunStop(attempt)) return false;
  if (attempt.outcome && TRIGGER_CODES.includes(`${attempt.outcome}/${attempt.errorCode ?? ""}`)) return true;
  return askedLiveQuestion(attempt.workerEvents);
}

export type PostmortemEvidence = {
  attemptId: string;
  complaintId: string;
  category: FilingAttempt["category"];
  outcome: FilingAttempt["outcome"];
  errorCode: FilingAttempt["errorCode"];
  events: WorkerEvent[];
  evidence: { id: string; type: string; step: string | null; summary: string }[];
  formSchema: FormSchema | null;
  /** The category's required fields before this run (learned schema / catalog row); null when unknown. */
  currentRequiredFields: string[] | null;
  traceId: string | null;
};

/** #11: every `form_schema` worker event carries one step ({stepTitle, fields}); rebuild the run's schema (structure only). */
function schemaFromEvents(events: WorkerEvent[]): FormSchema | null {
  const steps = events
    .filter((e) => e.message === "form_schema" && e.data && Array.isArray((e.data as { fields?: unknown }).fields))
    .map((e) => ({ title: (e.data as { stepTitle?: unknown }).stepTitle, fields: (e.data as { fields: unknown[] }).fields }));
  return steps.length ? sanitizeFormSchema({ steps, capturedAt: events[events.length - 1]?.ts }) : null;
}

/** Collect what the run left behind. Evidence ids are what the diagnosis must cite. */
export function gatherEvidence(attempt: PostmortemAttempt, currentRequiredFields: string[] | null = null): PostmortemEvidence {
  return {
    attemptId: attempt.id,
    complaintId: attempt.complaintId,
    category: attempt.category,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
    events: attempt.workerEvents,
    evidence: attempt.evidence.map((e) => ({ id: e.id, type: e.type, step: e.step, summary: e.summary })),
    formSchema: (attempt.formSchema ? sanitizeFormSchema(attempt.formSchema) : null) ?? schemaFromEvents(attempt.workerEvents),
    currentRequiredFields,
    traceId: attempt.traceId,
  };
}

const SYSTEM_PROMPT = `You diagnose why an automated NYC 311 form-filing run did not cleanly submit.
Return ONLY JSON matching the schema: { cause, proposedChanges:[{kind,before,after,evidence}], confidence }.
- cause: missing_required_field | selector_changed | new_step | confirmation_pattern | captcha | unknown
- kind requiredField: "after" is the exact field label the form required; "before" null.
- Every change MUST cite evidence ids taken verbatim from the provided evidence list. Never invent ids.
- If unsure, use cause "unknown", no changes, low confidence. Never propose bypassing a captcha.`;

export type Diagnoser = (ev: PostmortemEvidence) => Promise<RepairDiagnosis>;

/** Default LLM diagnoser (existing OpenRouter client, strict json_schema). */
export const llmDiagnose: Diagnoser = async (ev) => {
  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(ev) },
  ];
  const res = await chatJson(RepairDiagnosis, messages, { model, maxTokens: 900, schemaName: "repair_diagnosis" });
  return res.data;
};

/** Drop evidence ids the model invented; drop changes left without evidence. */
export function sanitizeDiagnosis(d: RepairDiagnosis, ev: PostmortemEvidence): RepairDiagnosis {
  const known = new Set(ev.evidence.map((e) => e.id));
  const proposedChanges = d.proposedChanges
    .map((c) => ({ ...c, evidence: c.evidence.filter((id) => known.has(id)) }))
    .filter((c) => c.evidence.length > 0);
  return { ...d, proposedChanges };
}

/** Gather → diagnose → pending RepairProposal. */
export async function diagnose(attempt: PostmortemAttempt, opts: { diagnoser?: Diagnoser; now?: () => Date; currentRequiredFields?: string[] | null } = {}): Promise<RepairProposal> {
  const ev = gatherEvidence(attempt, opts.currentRequiredFields ?? null);
  const raw = RepairDiagnosis.parse(await (opts.diagnoser ?? llmDiagnose)(ev));
  const d = sanitizeDiagnosis(raw, ev);
  return RepairProposal.parse({
    ...d,
    id: shortId("rep"),
    attemptId: attempt.id,
    complaintId: attempt.complaintId,
    category: attempt.category,
    status: "pending",
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    decidedAt: null,
    decidedBy: null,
    applied: [],
  });
}

/**
 * Deterministic guard: a change may be auto-applied only if it is a
 * `requiredField` ADDITION (before === null), backed by evidence, and the
 * proposal confidence is >= 0.9. Everything else waits for a human.
 */
export function isAutoApplicable(p: Pick<RepairProposal, "confidence">, c: RepairChange): boolean {
  return c.kind === "requiredField" && c.before === null && c.after.trim().length > 0 && c.evidence.length > 0 && p.confidence >= REPAIR_AUTO_APPLY_CONFIDENCE;
}

export function autoApplicableChanges(p: RepairProposal): RepairChange[] {
  return p.proposedChanges.filter((c) => isAutoApplicable(p, c));
}

/** Approve/reject transition (pure). Throws if already decided. */
export function decideProposal(p: RepairProposal, decision: "approved" | "rejected", now: Date = new Date(), by: "auto" | "operator" = "operator"): RepairProposal {
  if (p.status !== "pending") throw new Error(`proposal ${p.id} already ${p.status}`);
  return { ...p, status: decision, decidedAt: now.toISOString(), decidedBy: by };
}

// ---------------------------------------------------------------------------
// applying (requiredField only) — through #11's schema path
// ---------------------------------------------------------------------------
export const LEARNED_STEP_TITLE = "Learned from post-mortem";

/** The category's required fields right now: learned schema memory first, else the catalog row. */
export async function currentRequiredFields(store: Store, category: string): Promise<{ requiredFields: string[] | null; formSchema: FormSchema | null }> {
  const cur = await readCurrentSchema(store, category).catch(() => null);
  if (cur) return { requiredFields: cur.requiredFields, formSchema: cur.formSchema };
  const row = (await store.listCatalog?.().catch(() => []))?.find((e) => e.id === category);
  return { requiredFields: row?.requiredFields ?? null, formSchema: row?.formSchema ?? null };
}

/** Pure: mark `labels` required in `base` (existing field ⇒ required: true; unknown ⇒ appended to a learned step). */
export function withRequiredFields(base: FormSchema | null, labels: string[], capturedAt: string): FormSchema {
  const steps = structuredClone(base?.steps ?? []);
  for (const label of labels) {
    const hit = steps.flatMap((s) => s.fields).filter((f) => f.label.toLowerCase() === label.toLowerCase());
    if (hit.length) {
      for (const f of hit) f.required = true;
      continue;
    }
    let learned = steps.find((s) => s.title === LEARNED_STEP_TITLE);
    if (!learned) steps.push((learned = { title: LEARNED_STEP_TITLE, fields: [] }));
    learned.fields.push({ label, type: "unknown", required: true, step: LEARNED_STEP_TITLE });
  }
  return { steps, capturedAt };
}

/**
 * Write the proposal's `requiredField` additions into the category schema via #11's recordFormSchema (memory current +
 * history items, catalog row requiredFields/formSchema, lastVerifiedAt = now). Returns the labels written.
 */
export async function applyRequiredFields(
  deps: { store: Store; memory?: Pick<AgentMemory, "remember"> | null },
  p: RepairProposal,
  changes: RepairChange[],
  now: Date = new Date(),
): Promise<string[]> {
  const labels = [...new Set(changes.filter((c) => c.kind === "requiredField" && c.after.trim()).map((c) => c.after.trim()))];
  if (!labels.length) return [];
  const { formSchema } = await currentRequiredFields(deps.store, p.category);
  const patched = withRequiredFields(formSchema, labels, now.toISOString());
  const rec = await recordFormSchema(
    { store: deps.store, memory: deps.memory ?? null },
    { category: p.category, attempt: { id: `${p.attemptId}_${p.id}`, traceId: null }, outcome: "HUMAN_ACTION_REQUIRED", formSchema: patched },
  );
  if (!rec) return [];
  return labels.filter((l) => rec.requiredFields.some((r) => r.toLowerCase() === l.toLowerCase()));
}

/** Operator decision (POST /api/repairs/:id/approve|reject). Approve applies requiredField changes only. */
export async function decideAndApply(
  deps: { store: Store; memory?: Pick<AgentMemory, "remember"> | null },
  p: RepairProposal,
  decision: "approved" | "rejected",
  now: Date = new Date(),
): Promise<RepairProposal> {
  const decided = decideProposal(p, decision, now, "operator");
  if (decision === "approved") {
    const applied = await applyRequiredFields(deps, p, p.proposedChanges, now);
    decided.applied = [...new Set([...(p.applied ?? []), ...applied])];
  }
  await deps.store.saveRepairProposal?.(decided);
  return decided;
}

// ---------------------------------------------------------------------------
// the async job
// ---------------------------------------------------------------------------
export type PostmortemDeps = {
  store: Store;
  tracer?: Tracer | null;
  memory?: Pick<AgentMemory, "remember" | "reflect"> | null;
  diagnoser?: Diagnoser;
  now?: () => Date;
};

export type PostmortemResult = {
  proposal: RepairProposal;
  /** requiredField labels auto-applied (confidence ≥ 0.9): the resident is told "next time I'll ask for X up front". */
  askUpFront: string[];
};

async function runPostmortemInner(deps: PostmortemDeps, attemptId: string, set: (k: string, v: string | number | boolean) => void): Promise<PostmortemResult | null> {
  const { store } = deps;
  if (!store.saveRepairProposal) return null;
  const attempt = await store.getAttempt(attemptId);
  if (!attempt || !shouldPostmortem(attempt)) return null;
  // one proposal per attempt
  const existing = (await store.listRepairProposals?.({ limit: 500 })) ?? [];
  if (existing.some((p) => p.attemptId === attemptId)) return null;

  const now = deps.now ?? (() => new Date());
  const { requiredFields } = await currentRequiredFields(store, attempt.category);
  let proposal = await diagnose(attempt, { diagnoser: deps.diagnoser, now, currentRequiredFields: requiredFields });
  set("repair.cause", proposal.cause);
  set("repair.confidence", proposal.confidence);
  set("repair.changes", proposal.proposedChanges.length);
  if (!proposal.proposedChanges.length) return null;

  // Already-known required fields are not news.
  const known = new Set((requiredFields ?? []).map((l) => l.toLowerCase()));
  const auto = autoApplicableChanges(proposal).filter((c) => !known.has(c.after.trim().toLowerCase()));
  let askUpFront: string[] = [];
  if (auto.length) {
    askUpFront = await applyRequiredFields({ store, memory: deps.memory ?? null }, proposal, auto, now());
    proposal = { ...proposal, applied: askUpFront };
    // Everything in the proposal was auto-applicable ⇒ decided by the guard; else it waits for an operator.
    if (askUpFront.length && proposal.proposedChanges.every((c) => isAutoApplicable(proposal, c))) proposal = decideProposal(proposal, "approved", now(), "auto");
  }
  await store.saveRepairProposal(proposal);
  set("repair.id", proposal.id);
  set("repair.status", proposal.status);
  set("repair.auto_applied", askUpFront.length);

  if (deps.memory) {
    const what = proposal.proposedChanges.map((c) => `${c.kind}: ${c.before ?? "∅"} → ${c.after}`).join("; ");
    await deps.memory
      .reflect(attemptId, `Post-mortem (${proposal.cause}, confidence ${proposal.confidence.toFixed(2)}): ${what}. Status ${proposal.status}.`, { repairProposalId: proposal.id, category: proposal.category })
      .catch((e) => console.warn("[postmortem] reflect:", (e as Error).message));
  }
  return { proposal, askUpFront };
}

/**
 * Gather → diagnose → store a repair_proposal (+ auto-apply guard, reflect note). Meant to be fired async after the
 * outcome message; never throws (returns null on any failure or when the attempt doesn't qualify).
 */
export async function runPostmortem(deps: PostmortemDeps, attemptId: string): Promise<PostmortemResult | null> {
  try {
    if (!deps.tracer) return await runPostmortemInner(deps, attemptId, () => {});
    return await deps.tracer.span("postmortem.run", { "attempt.id": attemptId }, (set) => runPostmortemInner(deps, attemptId, set));
  } catch (err) {
    console.warn("[postmortem] failed:", (err as Error).message);
    return null;
  }
}
