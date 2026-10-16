/**
 * SurrealDB memory features (design doc §11.3 "memory-assisted", §8.1 "context collector").
 *
 * A. Memory-driven intake ("learn what to ask up front"): when a filing attempt
 *    ends HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD (or the worker asks a
 *    live question), we upsert a WorkflowPattern { kind: "ask-before-approval",
 *    hint: { field, prompt, options?, count } } per target+category+field. The
 *    orchestrator loads these before READY_FOR_APPROVAL and asks for any field
 *    that is still empty, so the next filing doesn't stall on it.
 *
 * B. Remembered issues ("you/others already reported this"): pure helpers for
 *    the related-complaint query (memory store) and the card lines.
 *
 * Nothing here invents a value: every answer stored comes from the resident.
 *
 * C. Reads through AgentMemory (#4): `readAskPatterns` / `readRelated` keep the
 *    store queries as the structural filter (so behaviour is unchanged) and use
 *    `memory.recall()` to rank/explain them; the RETRIEVER span documents carry
 *    the recall score + breakdown. These are the orchestrator's only memory reads.
 */
import type {
  AgentMemory,
  CategoryId,
  ComplaintDraft,
  ComplaintState,
  FilingErrorCode,
  FilingStatus,
  FilingTarget,
  MemoryItem,
  RelatedComplaint,
  RelatedComplaints,
  RelatedComplaintsQuery,
  Resident,
  ScoredMemory,
  Store,
  WorkerResult,
  WorkflowPattern,
} from "../core/contracts.js";
import { haversineMeters, nowIso, questionFromEvent } from "../core/contracts.js";
import { getCategory, isOpenDataBacked, requiredFieldsFor, resolveDirection } from "../core/knowledge.js";
import { readyForApprovalItem } from "./agent-memory.js";
import { esc } from "../telegram/messages.js";

// ---------------------------------------------------------------------------
// A. ask-before-approval patterns
// ---------------------------------------------------------------------------
export const ASK_KIND = "ask-before-approval";

export type AskHint = { field: string; prompt: string; options?: string[]; count: number; attemptIds: string[] };
export type AskObservation = { field: string; prompt: string; options?: string[] };

/** Fields the existing transit question machinery (line → direction → time) already asks; memory only reports them. */
export const MACHINERY_FIELDS = new Set(["line", "direction", "incident_time", "description"]);

/** Worker field ids / form labels → our canonical field names. */
export function normalizeField(raw: string): string {
  const s = String(raw ?? "").toLowerCase();
  if (/direction|bound\b/.test(s)) return "direction";
  if (/station|\bstop\b/.test(s)) return "station";
  if (/transit\.line|subway line|\bline\b|\broute\b/.test(s)) return "line";
  if (/e-?mail/.test(s)) return "contact_email";
  if (/\bname\b/.test(s)) return "contact_name";
  if (/time|when|date/.test(s)) return "incident_time";
  if (/description|tell us more/.test(s)) return "description";
  return s.replace(/^transit\./, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "unknown";
}

const FIELD_LABEL: Record<string, string> = {
  direction: "the direction",
  station: "the station",
  line: "the line",
  contact_name: "your name",
  contact_email: "your email",
  incident_time: "the time",
  description: "a description",
};
export const fieldLabel = (field: string) => FIELD_LABEL[field] ?? `“${field.replace(/_/g, " ")}”`;

/** Strip the trailing "(what the user said …)" parenthetical so the prompt is reusable for the next resident. */
function reusablePrompt(message: string): string {
  const m = message.replace(/\s*\([^()]*\)\s*\.?\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 300);
  return m && !/[.?!:]$/.test(m) ? `${m}.` : m;
}

/**
 * Which field(s) a finished attempt needed from the resident:
 *  - live questions the worker asked mid-filing (`question` steps, any outcome), and
 *  - the field a HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD outcome stalled on (the outcome step's
 *    `data` from `needField(message, { field | fields | label, options })` in the worker).
 */
export function askFromOutcome(status: FilingStatus, code: FilingErrorCode | null, result: WorkerResult | null): AskObservation[] {
  if (!result) return [];
  const out: AskObservation[] = [];
  const opts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : undefined);
  for (const st of result.steps) {
    const q = questionFromEvent(st);
    if (!q) continue;
    const options = opts(q.options);
    out.push({ field: q.field === "free_text" ? normalizeField(q.prompt) : q.field, prompt: reusablePrompt(q.prompt), ...(options?.length ? { options } : {}) });
  }
  const stalled = status === "HUMAN_ACTION_REQUIRED" && code === "UNEXPECTED_REQUIRED_FIELD";
  const step = stalled ? [...result.steps].reverse().find((s) => s.message !== "question" && s.data && (s.data.field || s.data.fields || s.data.label)) : undefined;
  const data = (step?.data ?? {}) as Record<string, unknown>;
  const message = reusablePrompt(result.message ?? step?.message?.replace(/^outcome [A-Z_/]+: /, "") ?? "");
  if (!stalled) {
    // fall through to the de-duplication below with live questions only
  } else if (typeof data.field === "string") {
    const options = opts(data.optionsShort) ?? opts(data.options);
    out.push({ field: normalizeField(data.field), prompt: message, ...(options?.length ? { options } : {}) });
  } else if (Array.isArray(data.fields)) {
    for (const f of data.fields as { label?: string; name?: string }[]) {
      const label = String(f?.label || f?.name || "").trim();
      if (!label) continue;
      out.push({ field: normalizeField(label), prompt: `The form asked for “${label.slice(0, 60)}” last time. What should I put there?` });
    }
  } else if (typeof data.label === "string") {
    out.push({ field: normalizeField(data.label), prompt: message });
  }
  const seen = new Set<string>();
  return out.filter((o) => o.field !== "unknown" && !seen.has(o.field) && seen.add(o.field));
}

export function askPatternId(target: FilingTarget, category: CategoryId, field: string): string {
  return `wp_ask_${target}_${category}_${field}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function readAskHint(p: WorkflowPattern): AskHint | null {
  if (p.kind !== ASK_KIND) return null;
  const h = p.hint as Record<string, unknown>;
  if (typeof h.field !== "string" || !h.field) return null;
  const attemptIds = Array.isArray(h.attemptIds) ? h.attemptIds.filter((x): x is string => typeof x === "string") : p.observedInAttemptId ? [p.observedInAttemptId] : [];
  const options = Array.isArray(h.options) ? h.options.filter((x): x is string => typeof x === "string") : undefined;
  return {
    field: h.field,
    prompt: typeof h.prompt === "string" ? h.prompt : "",
    ...(options?.length ? { options } : {}),
    count: typeof h.count === "number" && h.count > 0 ? h.count : Math.max(1, attemptIds.length),
    attemptIds,
  };
}

/** All ask-before-approval hints for a route, merged by field (newest prompt wins, counts summed). */
export function askHints(patterns: WorkflowPattern[]): AskHint[] {
  const byField = new Map<string, AskHint>();
  const sorted = [...patterns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of sorted) {
    const h = readAskHint(p);
    if (!h) continue;
    const prev = byField.get(h.field);
    if (!prev) byField.set(h.field, h);
    else byField.set(h.field, { ...h, prompt: h.prompt || prev.prompt, options: h.options ?? prev.options, count: prev.count + h.count, attemptIds: [...new Set([...prev.attemptIds, ...h.attemptIds])] });
  }
  return [...byField.values()];
}

/**
 * Upsert one ask-before-approval pattern per target+category+field (deterministic id),
 * incrementing `count` (read-modify-write over recordWorkflowPattern).
 */
export async function recordAskPattern(
  store: Store,
  args: { target: FilingTarget; category: CategoryId; observation: AskObservation; attemptId: string | null; outcome: FilingStatus | null },
): Promise<WorkflowPattern> {
  const { target, category, observation, attemptId } = args;
  const id = askPatternId(target, category, observation.field);
  const existing = (await store.getWorkflowPatterns({ target, category })).find((p) => p.id === id || (p.kind === ASK_KIND && (p.hint as { field?: string }).field === observation.field));
  const prev = existing ? readAskHint(existing) : null;
  const attemptIds = [...new Set([...(prev?.attemptIds ?? []), ...(attemptId ? [attemptId] : [])])].slice(-20);
  const count = attemptId && prev?.attemptIds.includes(attemptId) ? prev.count : (prev?.count ?? 0) + 1;
  const options = observation.options ?? prev?.options;
  const p: WorkflowPattern = {
    id,
    target,
    category,
    kind: ASK_KIND,
    description: `The official form stopped on ${fieldLabel(observation.field)} in ${count} earlier filing${count === 1 ? "" : "s"}: ask the resident before approval.`,
    hint: { field: observation.field, prompt: observation.prompt || prev?.prompt || "", ...(options?.length ? { options } : {}), count, attemptIds },
    observedInAttemptId: attemptId,
    outcome: args.outcome,
    createdAt: nowIso(),
  };
  await store.recordWorkflowPattern(p);
  return p;
}

/** Current value of a learned field on the draft / resident (null = still empty ⇒ ask). */
export function fieldValue(draft: ComplaintDraft, resident: Pick<Resident, "contactName" | "contactEmail">, field: string): string | null {
  const t = draft.transit;
  switch (field) {
    case "direction":
      return t?.direction ?? null;
    case "station":
      return t?.station ?? null;
    case "line":
      return t?.line ?? null;
    case "incident_time":
      return t?.incidentTime ?? null;
    case "contact_name":
      return resident.contactName ?? null;
    case "contact_email":
      return resident.contactEmail ?? null;
    case "description":
      return draft.description || null;
    default: {
      // #12 stores answers under the official label; a learned pattern's normalized field id matches it too
      const x = draft.extraFields ?? {};
      return x[field]?.trim() || Object.entries(x).find(([k, v]) => normalizeField(k) === field && v.trim())?.[1]?.trim() || null;
    }
  }
}

/** The question we send for a learned field (generic free text; options listed when the form offered them). */
export function askPrompt(h: AskHint): string {
  const n = h.count;
  const lead = `🧠 <i>Learned from ${n} earlier filing${n === 1 ? "" : "s"}: the form needs ${esc(fieldLabel(h.field))}, so I'm asking now.</i>`;
  let q: string;
  switch (h.field) {
    case "station":
      q = "Which station were you at (or nearest station)?";
      break;
    case "contact_name":
      q = "What first and last name should I give the form?";
      break;
    case "contact_email":
      q = "Which email should the form use for a reply?";
      break;
    default:
      q = h.prompt ? esc(h.prompt) : `What should I put for ${esc(fieldLabel(h.field))}?`;
  }
  const opts = h.options?.length ? `\n${h.options.map((o, i) => `${i + 1}. ${esc(o)}`).join("\n")}` : "";
  return `${lead}\n\n${q}${opts}\n\n<i>Reply with the answer, or “skip”.</i>`;
}

export type LearnedAnswer =
  | { kind: "skip" }
  | { kind: "invalid"; message: string }
  | { kind: "transit"; patch: { station: string } }
  | { kind: "resident"; patch: { contactName?: string; contactEmail?: string } }
  | { kind: "extra"; field: string; value: string };

export function parseLearnedAnswer(h: Pick<AskHint, "field" | "options">, text: string): LearnedAnswer {
  const v = text.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!v || /^(skip|no|not sure|don'?t know|idk|dunno|unknown|n\/a)\b/i.test(v)) return { kind: "skip" };
  const byIndex = /^\d{1,2}$/.test(v) ? h.options?.[Number(v) - 1] : undefined;
  const value = byIndex ?? h.options?.find((o) => o.toLowerCase() === v.toLowerCase()) ?? v;
  switch (h.field) {
    case "station":
      return { kind: "transit", patch: { station: value } };
    case "contact_name":
      return value.split(" ").length >= 2 && value.length <= 80 ? { kind: "resident", patch: { contactName: value } } : { kind: "invalid", message: "Please send a first and last name, like <code>Jane Doe</code> (or “skip”)." };
    case "contact_email":
      return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(value) ? { kind: "resident", patch: { contactEmail: value } } : { kind: "invalid", message: "That doesn't look like an email. Try again, or “skip”." };
    default:
      return { kind: "extra", field: h.field, value };
  }
}

/** Card line: memory at work. */
export function memoryCardLine(hints: AskHint[]): string | null {
  if (!hints.length) return null;
  const n = new Set(hints.flatMap((h) => h.attemptIds)).size || Math.max(...hints.map((h) => h.count));
  const fields = hints.map((h) => fieldLabel(h.field));
  const list = fields.length <= 2 ? fields.join(" and ") : `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
  return `🧠 <i>Learned from ${n} earlier filing${n === 1 ? "" : "s"}: asked for ${esc(list)} up front.</i>`;
}

// ---------------------------------------------------------------------------
// B. remembered issues
// ---------------------------------------------------------------------------
export const RELATED_DEFAULTS = { radiusMeters: 100, sinceMs: 24 * 3600_000, othersSinceMs: 2 * 3600_000 } as const;
/** Statuses that never count as "reported". */
export const NOT_REPORTED = ["EMERGENCY_REFERRAL", "OUT_OF_SCOPE", "RECEIVED", "TRIAGING"] as const;
/** For other residents we only count reports that reached the approval card. */
export const NOT_REPORTED_OTHERS = [...NOT_REPORTED, "CANCELLED", "NEEDS_INFORMATION", "DUPLICATE_REVIEW"] as const;

/** Reference implementation (memory store) of Store.findRelatedComplaints. */
export function filterRelated(all: ComplaintDraft[], q: RelatedComplaintsQuery, nowMs = Date.now()): RelatedComplaints {
  const radius = q.radiusMeters ?? RELATED_DEFAULTS.radiusMeters;
  const sinceMine = nowMs - (q.sinceMs ?? RELATED_DEFAULTS.sinceMs);
  const sinceOthers = nowMs - (q.othersSinceMs ?? RELATED_DEFAULTS.othersSinceMs);
  const geo = q.line ? null : q.lat != null && q.lon != null ? { lat: q.lat, lon: q.lon } : null;
  const rows: (RelatedComplaint & { chatId: string; t: number })[] = [];
  for (const c of all) {
    if (c.id === q.complaintId || c.category !== q.category) continue;
    if ((NOT_REPORTED as readonly string[]).includes(c.status)) continue;
    let distanceMeters: number | null = null;
    if (q.line) {
      if (c.transit?.line !== q.line) continue;
    } else if (geo) {
      if (c.location.latitude == null || c.location.longitude == null) continue;
      distanceMeters = haversineMeters(geo.lat, geo.lon, c.location.latitude, c.location.longitude);
      if (distanceMeters > radius) continue;
    } else continue;
    rows.push({ id: c.id, chatId: c.telegramChatId, t: Date.parse(c.createdAt), status: c.status, createdAt: c.createdAt, officialRequestNumber: c.officialRequestNumber, statusReason: c.statusReason, line: c.transit?.line ?? null, distanceMeters });
  }
  rows.sort((a, b) => b.t - a.t);
  const mine = rows.filter((r) => r.chatId === q.chatId && r.t >= sinceMine).slice(0, 5);
  const others = rows.filter((r) => r.chatId !== q.chatId && r.t >= sinceOthers && !(NOT_REPORTED_OTHERS as readonly string[]).includes(r.status));
  return {
    mine: mine.map(({ chatId: _c, t: _t, ...r }) => r),
    others: { reports: others.length, residents: new Set(others.map((r) => r.chatId)).size, latestAt: others[0]?.createdAt ?? null, oldestAt: others[others.length - 1]?.createdAt ?? null, ids: others.slice(0, 10).map((r) => r.id) },
  };
}

function agoText(iso: string, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} h ago`;
}

function statusText(r: RelatedComplaint): string {
  if (r.officialRequestNumber) return `SR ${r.officialRequestNumber}`;
  switch (r.status) {
    case "HUMAN_ACTION_REQUIRED":
      return /dry-run/i.test(r.statusReason ?? "") || !r.statusReason ? "dry run, nothing sent" : "waiting for you to finish it";
    case "CANCELLED":
      return "cancelled, not filed";
    case "FAILED":
      return "failed, not filed";
    case "SUBMISSION_UNKNOWN":
      return "outcome unknown";
    case "APPROVED":
    case "FILING":
      return "filing now";
    case "SUBMITTED":
    case "TRACKING":
      return "filed";
    default:
      return "draft, not filed";
  }
}

const lineName = (line: string) => (/^[0-9A-Z]$/.test(line) ? `${line} train` : line);

function issueLabel(category: CategoryId, line: string | null | undefined, plural: boolean): string {
  if (line) return `${plural ? "" : /^[AEFHILMNORSX]/.test(line) ? "an " : "a "}${lineName(line)} delay${plural ? "s" : ""}`;
  const label = (getCategory(category)?.label ?? "issue").toLowerCase();
  return `${plural ? "" : "a "}${label}${plural ? "s" : ""}`;
}

/** Card lines for the remembered issues (counts only for other residents; no PII). */
export function relatedCardLines(q: Pick<RelatedComplaintsQuery, "category" | "line" | "othersSinceMs">, r: RelatedComplaints, nowMs = Date.now()): string[] {
  const out: string[] = [];
  const latest = r.mine[0];
  if (latest) {
    const where = latest.distanceMeters != null ? ` ${Math.round(latest.distanceMeters)} m from here` : "";
    const more = r.mine.length > 1 ? ` (+${r.mine.length - 1} more in the last 24 h)` : "";
    out.push(`🔁 You reported ${esc(issueLabel(q.category, q.line, false))}${where} ${agoText(latest.createdAt, nowMs)} (${esc(statusText(latest))})${more}. File another?`);
  }
  if (r.others.residents > 0) {
    const n = r.others.residents;
    const who = q.line ? (n === 1 ? "other rider" : "other riders") : n === 1 ? "other resident" : "other residents";
    const span = r.others.oldestAt && nowMs - Date.parse(r.others.oldestAt) <= 3600_000 ? "in the last hour" : `in the last ${Math.round((q.othersSinceMs ?? RELATED_DEFAULTS.othersSinceMs) / 3600_000)} hours`;
    const near = q.line ? "" : ` within ${RELATED_DEFAULTS.radiusMeters} m`;
    out.push(`👥 ${n} ${who} reported ${esc(issueLabel(q.category, q.line, true))}${near} ${span}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// C. reads through AgentMemory (structural filter from the store, ranking + explanation from recall)
// ---------------------------------------------------------------------------
export type RetrieverDoc = { id: string; content: string; score?: number; metadata?: Record<string, unknown> };

/** Recall must never hold up the approval card: past the budget we answer from the store alone. */
export const RECALL_BUDGET_MS = 2500;

async function recallWithin(memory: AgentMemory | null | undefined, q: Parameters<AgentMemory["recall"]>[0]): Promise<ScoredMemory[]> {
  if (!memory) return [];
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([memory.recall(q), new Promise<ScoredMemory[]>((r) => (timer = setTimeout(() => r([]), RECALL_BUDGET_MS)))]);
  } catch (err) {
    console.warn("[memory] recall failed:", (err as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const explain = (m: ScoredMemory | undefined) => (m ? { memory: { id: m.id, text: m.text, score: m.score, breakdown: m.breakdown } } : {});

/** A. ask-before-approval hints for a route: patterns from the store; scores from procedural memory. */
export async function readAskPatterns(
  store: Store,
  memory: AgentMemory | null | undefined,
  route: { target: FilingTarget; category: CategoryId },
): Promise<{ patterns: WorkflowPattern[]; hints: AskHint[]; docs: RetrieverDoc[] }> {
  const [patterns, recalled] = await Promise.all([store.getWorkflowPatterns(route), recallWithin(memory, { kind: "procedural", scope: { category: route.category }, limit: 50 })]);
  const byPattern = new Map<string, ScoredMemory>();
  for (const m of recalled) {
    const id = (m.data as { patternId?: unknown }).patternId;
    if (typeof id === "string" && !byPattern.has(id)) byPattern.set(id, m);
  }
  const docs = patterns.slice(0, 10).map((p) => {
    const h = p.hint as { field?: unknown; count?: unknown };
    const m = byPattern.get(p.id);
    return { id: p.id, content: `${p.kind}: ${p.description}`, score: m?.score ?? (p.kind === ASK_KIND ? 1 : 0.3), metadata: { kind: p.kind, field: h.field ?? null, count: h.count ?? null, observedInAttemptId: p.observedInAttemptId, ...explain(m) } };
  });
  return { patterns, hints: askHints(patterns), docs };
}

/**
 * B. Remembered issues: the store's related-complaint query decides WHAT is related (unchanged); recall over the
 * resident's own episodic memory (scope.chatId — never other residents' items) ranks and explains "mine".
 * Other residents stay counts only.
 */
export async function readRelated(
  store: Store,
  memory: AgentMemory | null | undefined,
  q: RelatedComplaintsQuery,
  queryText: string,
): Promise<{ related: RelatedComplaints; docs: RetrieverDoc[] }> {
  const geo = !q.line && q.lat != null && q.lon != null ? { lat: q.lat, lon: q.lon, radiusMeters: q.radiusMeters ?? RELATED_DEFAULTS.radiusMeters } : null;
  const [related, recalled] = await Promise.all([
    store.findRelatedComplaints!(q),
    recallWithin(memory, { text: queryText, kind: "episodic", scope: { chatId: q.chatId, category: q.category, line: q.line ?? null, geo }, sinceMs: q.sinceMs ?? RELATED_DEFAULTS.sinceMs, limit: 30 }),
  ]);
  const byComplaint = new Map<string, ScoredMemory>();
  for (const m of recalled) {
    const id = (m.data as { complaintId?: unknown }).complaintId;
    if (typeof id === "string" && m.chatId === q.chatId && !byComplaint.has(id)) byComplaint.set(id, m);
  }
  const docs: RetrieverDoc[] = [
    ...related.mine.map((m) => {
      const s = byComplaint.get(m.id);
      return { id: m.id, content: `your ${m.status} report at ${m.createdAt}${m.officialRequestNumber ? ` (SR ${m.officialRequestNumber})` : ""}`, score: s?.score ?? 1, metadata: { status: m.status, distanceMeters: m.distanceMeters, ...explain(s) } };
    }),
    ...related.others.ids.map((id) => ({ id, content: "another resident's report (same category, same line / nearby)", score: 0.8 })),
  ];
  return { related, docs };
}

// ---------------------------------------------------------------------------
// D. same issue across residents (#5): "this was already raised — raise another?"
//
// Match = the top episodic recall hit ACROSS residents (no chatId scope; scope = category + line / geo)
// whose recall score ≥ SAME_ISSUE.threshold AND structural agreement with the authoritative complaint row:
// same category; transit: same line + compatible direction + |Δ incident time| ≤ 3 h; geo: ≤ 100 m.
// Privacy: other residents' chat ids / contact fields never leave this function; a match carries only the
// neutral (classifier) description, a time bucket, the status and the official reference.
// ---------------------------------------------------------------------------
export const SAME_ISSUE = {
  /**
   * On the recall score (0.5·relevance + 0.3·recency + 0.2·importance); tuned on fixtures/duplicates/*.json
   * (hash embedder): matches 0.78 (40 min apart, other station) / 0.83 (paraphrase) / 0.88 (same words);
   * an unrelated report on the same line + direction + time scores 0.65. Structural misses (other line,
   * opposite direction, 5 h apart) score 0.81–0.88 and are rejected by the gate, not by the threshold.
   */
  threshold: 0.7,
  maxDeltaMs: 3 * 3600_000,
  radiusMeters: 100,
  /** Recall window (the time gate decides; this only bounds the candidate pool). */
  sinceMs: 24 * 3600_000,
  /** "N people reported this in the last 2 hours". */
  countWindowMs: 2 * 3600_000,
  limit: 30,
  /**
   * #22: the same-issue check gates the approval card, so it waits at most this long for the query embedding;
   * past it, recall uses keyword relevance (and the embedding is cached for the next turn).
   */
  // The orchestrator pre-warms the embedding right after classification (memory.warm), so by the time the
  // same-issue gate runs the vector is normally cached (<5 ms). The budget only matters on a cold cache
  // (first OpenRouter call ≈ 1.9 s, or an outage): wait at most 600 ms, then fall back to keyword overlap.
  embedBudgetMs: 600,
} as const;

/** Statuses an original must NOT be in to count as "already raised". */
export const NOT_RAISED: readonly string[] = NOT_REPORTED_OTHERS;

export type SameIssueChoice = "join" | "different";

export type SameIssueBreakdown = {
  score: number;
  threshold: number;
  relevance: number;
  relevanceKind: ScoredMemory["breakdown"]["relevanceKind"];
  recency: number;
  importance: number;
  sameLine: boolean | null;
  direction: "same" | "unknown" | null;
  deltaMinutes: number | null;
  distanceMeters: number | null;
};

export type SameIssueMatch = {
  originalId: string;
  memoryId: string;
  category: CategoryId;
  line: string | null;
  /** Canonical MTA direction label of the original (or as said), null when unknown. */
  direction: string | null;
  station: string | null;
  /** The original's classifier description (neutral by construction), never the resident's own words. */
  neutralDescription: string;
  /** "40 min ago", "about 2 hours ago" (from the incident time, else when it was reported). */
  timeBucket: string;
  status: ComplaintState;
  officialRequestNumber: string | null;
  /** Residents who already joined the original. */
  supporters: number;
  /** Distinct other residents who reported / joined this issue in the last 2 hours. */
  recentReporters: number;
  breakdown: SameIssueBreakdown;
};

type AgreementInput = Pick<ComplaintDraft, "category" | "transit" | "location" | "createdAt">;
export type SameIssueAgreement = { ok: boolean; reason: string | null; sameLine: boolean | null; direction: "same" | "unknown" | null; deltaMinutes: number | null; distanceMeters: number | null };

const canonDirection = (line: string | null | undefined, d: string | null | undefined): string | null => (d?.trim() ? (resolveDirection(line, d) ?? d.trim().toLowerCase()) : null);
const incidentMs = (d: Pick<ComplaintDraft, "transit" | "createdAt">) => {
  const t = d.transit?.incidentTime ? Date.parse(d.transit.incidentTime) : NaN;
  return Number.isFinite(t) ? t : Date.parse(d.createdAt);
};

/** Structural agreement between the draft and another resident's complaint (the authoritative store row). */
export function sameIssueAgreement(draft: AgreementInput, other: AgreementInput): SameIssueAgreement {
  const no = (reason: string): SameIssueAgreement => ({ ok: false, reason, sameLine: null, direction: null, deltaMinutes: null, distanceMeters: null });
  if (!draft.category || draft.category !== other.category) return no("category");
  if (requiredFieldsFor(draft.category).includes("transit")) {
    const line = draft.transit?.line ?? null;
    if (!line || other.transit?.line !== line) return no("line");
    const a = canonDirection(line, draft.transit?.direction);
    const b = canonDirection(line, other.transit?.direction);
    if (a && b && a !== b) return no("direction");
    const deltaMs = Math.abs(incidentMs(draft) - incidentMs(other));
    if (!Number.isFinite(deltaMs) || deltaMs > SAME_ISSUE.maxDeltaMs) return no("time");
    return { ok: true, reason: null, sameLine: true, direction: a && b ? "same" : "unknown", deltaMinutes: Math.round(deltaMs / 60_000), distanceMeters: null };
  }
  // geo categories (none today; the code path stays for later)
  const p = draft.location;
  const q = other.location;
  if (p.latitude == null || p.longitude == null || q.latitude == null || q.longitude == null) return no("geo");
  const distanceMeters = haversineMeters(p.latitude, p.longitude, q.latitude, q.longitude);
  if (distanceMeters > SAME_ISSUE.radiusMeters) return no("distance");
  return { ok: true, reason: null, sameLine: null, direction: null, deltaMinutes: null, distanceMeters: Math.round(distanceMeters) };
}

export function timeBucket(at: string | number, nowMs = Date.now()): string {
  const min = Math.max(0, Math.round((nowMs - (typeof at === "number" ? at : Date.parse(at))) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h === 1 ? "about an hour ago" : `about ${h} hours ago`;
}

/** The recall query for a draft: its own neutral memory text (classifier description + transit facts). */
export function sameIssueQueryText(draft: ComplaintDraft): string {
  return readyForApprovalItem(draft).text;
}

/** Episodic memory of the resident's choice (neutral: the draft's classifier description + transit facts). */
export function sameIssueChoiceItem(draft: ComplaintDraft, originalId: string, choice: SameIssueChoice): MemoryItem {
  const what = choice === "join" ? "Added to an existing report instead of filing a new one" : "Said this is a different issue from an existing report";
  return {
    id: `mem_same_${draft.id}_${originalId}`,
    kind: "episodic",
    text: `${what}: ${sameIssueQueryText(draft)}`,
    category: draft.category,
    chatId: draft.telegramChatId,
    line: draft.transit?.line ?? null,
    geo: draft.location.latitude != null && draft.location.longitude != null ? { lat: draft.location.latitude, lon: draft.location.longitude } : null,
    importance: choice === "join" ? 0.6 : 0.4,
    data: { complaintId: draft.id, sameIssueAs: originalId, sameIssueChoice: choice, incidentTime: draft.transit?.incidentTime ?? null, direction: draft.transit?.direction ?? null },
    source: `complaint:${draft.id}`,
    about: [
      { table: "complaint", id: draft.id },
      { table: "complaint", id: originalId },
    ],
  };
}

/**
 * Has another resident already raised the same issue? The best match (recall score ≥ threshold + structural
 * agreement) or null. Joined supporters' memory items count towards the original.
 */
export async function findSameIssue(
  deps: { store: Store; memory: AgentMemory | null | undefined; now?: () => number },
  draft: ComplaintDraft,
  opts: { queryText?: string; threshold?: number } = {},
): Promise<SameIssueMatch | null> {
  const { store, memory } = deps;
  if (!memory || !draft.category) return null;
  const nowMs = deps.now?.() ?? Date.now();
  const threshold = opts.threshold ?? SAME_ISSUE.threshold;
  const transit = requiredFieldsFor(draft.category).includes("transit");
  const line = transit ? (draft.transit?.line ?? null) : null;
  const lat = draft.location.latitude;
  const lon = draft.location.longitude;
  const geo = !transit && lat != null && lon != null ? { lat, lon, radiusMeters: SAME_ISSUE.radiusMeters } : null;
  if (transit ? !line : !geo) return null;
  const queryText = opts.queryText ?? sameIssueQueryText(draft);
  // ACROSS residents: no chatId in the scope (privacy is enforced below: nothing but neutral facts leaves).
  const hits = await recallWithin(memory, { kind: "episodic", text: queryText, scope: { category: draft.category, line, geo }, sinceMs: SAME_ISSUE.sinceMs, limit: SAME_ISSUE.limit, embedBudgetMs: SAME_ISSUE.embedBudgetMs });
  const links = await store.getIssueLinks?.(draft.id).catch(() => null);
  const dismissed = new Set(links?.notSameAs ?? []);
  const rows = new Map<string, Promise<ComplaintDraft | null>>();
  const load = (id: string) => {
    if (!rows.has(id)) rows.set(id, store.getComplaint(id).catch(() => null));
    return rows.get(id)!;
  };
  type Cand = { original: ComplaintDraft; hit: ScoredMemory; ag: SameIssueAgreement };
  const cands: Cand[] = [];
  for (const h of hits) {
    if (h.chatId == null || h.chatId === draft.telegramChatId) continue; // other residents only (own reports: relatedCardLines)
    const data = h.data as { complaintId?: unknown; sameIssueAs?: unknown; sameIssueChoice?: unknown };
    if (data.sameIssueChoice === "different" || typeof data.complaintId !== "string" || data.complaintId === draft.id) continue;
    let original = await load(data.sameIssueChoice === "join" && typeof data.sameIssueAs === "string" ? data.sameIssueAs : data.complaintId);
    if (original?.sameIssueAs) original = await load(original.sameIssueAs);
    if (!original || original.id === draft.id || original.telegramChatId === draft.telegramChatId || dismissed.has(original.id)) continue;
    if (NOT_RAISED.includes(original.status)) continue;
    const ag = sameIssueAgreement(draft, original);
    if (!ag.ok || h.score < threshold) continue;
    cands.push({ original, hit: h, ag });
  }
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => (b.hit.score > a.hit.score ? b : a));
  const recent = new Set(cands.filter((c) => Date.parse(c.hit.createdAt) >= nowMs - SAME_ISSUE.countWindowMs).map((c) => c.hit.chatId));
  const o = best.original;
  const supporters = (await store.getIssueLinks?.(o.id).catch(() => null))?.supporters ?? o.supporters ?? 0;
  const b = best.hit.breakdown;
  return {
    originalId: o.id,
    memoryId: best.hit.id,
    category: o.category!,
    line: o.transit?.line ?? null,
    direction: o.transit?.direction?.trim() ? (resolveDirection(o.transit.line, o.transit.direction) ?? o.transit.direction.trim()) : null,
    station: o.transit?.station ?? null,
    neutralDescription: o.classification?.description?.trim() ?? "",
    timeBucket: timeBucket(transit ? incidentMs(o) : Date.parse(o.createdAt), nowMs),
    status: o.status,
    officialRequestNumber: o.officialRequestNumber,
    supporters,
    recentReporters: recent.size,
    breakdown: {
      score: best.hit.score,
      threshold,
      relevance: b.relevance,
      relevanceKind: b.relevanceKind,
      recency: b.recency,
      importance: b.importance,
      sameLine: best.ag.sameLine,
      direction: best.ag.direction,
      deltaMinutes: best.ag.deltaMinutes,
      distanceMeters: best.ag.distanceMeters,
    },
  };
}

/** Human status of an original for the prompt ("filed", "draft, not filed", …) + its official reference. */
export function sameIssueStatus(m: Pick<SameIssueMatch, "status" | "officialRequestNumber" | "category">): string {
  const s = statusText({ id: "", status: m.status, createdAt: "", officialRequestNumber: null, statusReason: null, line: null, distanceMeters: null });
  if (!m.officialRequestNumber) return s;
  return `${s}, ${isOpenDataBacked(m.category) ? "SR" : "MTA ref"} ${m.officialRequestNumber}`;
}

/** "an A train delay, Downtown & Brooklyn, around 14 St" */
export function sameIssueLabel(m: Pick<SameIssueMatch, "category" | "line" | "direction" | "station">): string {
  return [issueLabel(m.category, m.line, false), m.direction, m.station ? `around ${m.station}` : null].filter(Boolean).join(", ");
}

/** "Looks like this was already raised: …" (HTML). Only neutral facts; the breakdown line is for the demo. */
export function sameIssuePrompt(m: SameIssueMatch): string {
  const lines = [`🔁 Looks like this was already raised: ${esc(sameIssueLabel(m))}, ${esc(m.timeBucket)} (status: ${esc(sameIssueStatus(m))}).`];
  if (m.neutralDescription) lines.push(`<i>“${esc(m.neutralDescription)}”</i>`);
  if (m.recentReporters > 0) {
    const n = m.recentReporters;
    lines.push(`👥 ${n} ${n === 1 ? "person" : "people"} reported this in the last ${Math.round(SAME_ISSUE.countWindowMs / 3600_000)} hours.`);
  }
  if (m.supporters > 0) lines.push(`➕ ${m.supporters} ${m.supporters === 1 ? "person has" : "people have"} added themselves to it.`);
  lines.push("", "Do you want to raise another issue, or add yourself to that one?");
  const b = m.breakdown;
  const facts = [b.sameLine ? "same line" : null, b.direction === "same" ? "same direction" : b.direction === "unknown" ? "direction unknown" : null, b.deltaMinutes != null ? `${b.deltaMinutes} min apart` : null, b.distanceMeters != null ? `${b.distanceMeters} m apart` : null]
    .filter(Boolean)
    .join(", ");
  lines.push(`<i>🧠 match ${b.score.toFixed(2)} ≥ ${b.threshold} (relevance ${b.relevance.toFixed(2)} ${b.relevanceKind} · recency ${b.recency.toFixed(2)} · importance ${b.importance.toFixed(2)}${facts ? `; ${facts}` : ""})</i>`);
  return lines.join("\n");
}
