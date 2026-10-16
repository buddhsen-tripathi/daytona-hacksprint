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
 */
import type {
  CategoryId,
  ComplaintDraft,
  FilingErrorCode,
  FilingStatus,
  FilingTarget,
  RelatedComplaint,
  RelatedComplaints,
  RelatedComplaintsQuery,
  Resident,
  Store,
  WorkerResult,
  WorkflowPattern,
} from "../core/contracts.js";
import { haversineMeters, nowIso, questionFromEvent } from "../core/contracts.js";
import { getCategory } from "../core/knowledge.js";
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
    default:
      return draft.extraFields?.[field]?.trim() || null;
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
