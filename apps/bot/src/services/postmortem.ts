/**
 * Post-mortem self-repair (#13) — scaffold.
 *
 * After a failed/ambiguous filing attempt we gather the evidence the run left
 * behind, ask the LLM for a strict-JSON diagnosis and turn it into a
 * RepairProposal. Proposals are NOT applied here: a human approves them on the
 * dashboard. The only exception is the deterministic guard below — a
 * `requiredField` addition with confidence >= 0.9 may be auto-applied.
 *
 * Not yet wired (blocked):
 *  - #11 adds `formSchema` to WorkerResult/FilingAttempt and `form_schema`
 *    worker events. Until then `gatherEvidence` reads it opportunistically.
 *  - #9 recipes: `recipeStep` changes have nowhere to be applied yet.
 *  - Phoenix trace spans / reflect() memory note / Telegram copy / evals.
 */
import {
  REPAIR_AUTO_APPLY_CONFIDENCE,
  RepairDiagnosis,
  RepairProposal,
  shortId,
  type FilingAttempt,
  type RepairChange,
  type WorkerEvent,
} from "../core/contracts.js";
import { chatJson, type ChatMessage } from "../integrations/openrouter.js";

/** Shape emitted by #11 (`form_schema` event / WorkerResult.formSchema). Kept loose until #11 lands. */
export type FormSchemaField = { label: string; type?: string; required?: boolean; options?: string[]; maxLength?: number; "selector-hint"?: string };
export type FormSchema = { stepTitle?: string; fields: FormSchemaField[] };

/** FilingAttempt plus the optional #11 field. */
export type PostmortemAttempt = FilingAttempt & { formSchema?: FormSchema | null };

const TRIGGER_CODES: ReadonlyArray<string> = [
  "HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD",
  "SUBMISSION_UNKNOWN/NO_CONFIRMATION",
  "FAILED/FORM_REJECTED",
];

function askedLiveQuestion(events: WorkerEvent[]): boolean {
  return events.some((e) => e.message === "question");
}

/** Which outcomes trigger a post-mortem (issue #13 "Behaviour"). */
export function shouldPostmortem(attempt: FilingAttempt): boolean {
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
  traceId: string | null;
};

function schemaFromEvents(events: WorkerEvent[]): FormSchema | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.message === "form_schema" && e.data && Array.isArray((e.data as { fields?: unknown }).fields)) return e.data as unknown as FormSchema;
  }
  return null;
}

/** Collect what the run left behind. Evidence ids are what the diagnosis must cite. */
export function gatherEvidence(attempt: PostmortemAttempt): PostmortemEvidence {
  return {
    attemptId: attempt.id,
    complaintId: attempt.complaintId,
    category: attempt.category,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
    events: attempt.workerEvents,
    evidence: attempt.evidence.map((e) => ({ id: e.id, type: e.type, step: e.step, summary: e.summary })),
    formSchema: attempt.formSchema ?? schemaFromEvents(attempt.workerEvents),
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
export async function diagnose(attempt: PostmortemAttempt, opts: { diagnoser?: Diagnoser; now?: () => Date } = {}): Promise<RepairProposal> {
  const ev = gatherEvidence(attempt);
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
export function decideProposal(p: RepairProposal, decision: "approved" | "rejected", now: Date = new Date()): RepairProposal {
  if (p.status !== "pending") throw new Error(`proposal ${p.id} already ${p.status}`);
  return { ...p, status: decision, decidedAt: now.toISOString() };
}
