/**
 * Conversation orchestrator (ARCHITECTURE.md "Flow" 1-10).
 *
 * The LLM classifies within bounds; this file decides what happens next and
 * every status change goes through state-machine.ts. Approval is a user
 * action bound to an exact draftVersion. Filing outcomes are rendered from
 * the FilingOutcome only; request numbers are never synthesized here.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentMemory,
  Classifier,
  ClassificationResult,
  ComplaintDraft,
  ComplaintLocation,
  DuplicateService,
  FilingOutcome,
  FilingTarget,
  InboundEvent,
  LocationService,
  MediaItem,
  OfficialRequest,
  OutboundMessage,
  Resident,
  Store,
  Tracer,
  Transport,
  WorkerAnswer,
  WorkerQuestion,
} from "./contracts.js";
import { decodeCallback, encodeCallback, nowIso, shortId } from "./contracts.js";
import {
  NYC311_CHECK_STATUS_URL,
  NYC311_REPORT_URL,
  allCategories,
  effectiveTarget,
  getCategory,
  isOpenDataBacked,
  isRealOnly,
  missingTransit,
  mtaDirectionOptions,
  nycIso,
  parseIncidentTime,
  requiredFieldsFor,
  resolveDirection,
  requiresContactName,
  transitHintsFromText,
} from "./knowledge.js";
import { canTransition, transition } from "./state-machine.js";
import { OPEN_STATES, createComplaintService, fmtIncidentTime, lineLabel } from "../services/complaints.js";
import { getActiveAlertsForLine, isDelayAlert, type MtaAlertsResult } from "../integrations/mta-alerts.js";
import { M, esc } from "../telegram/messages.js";
import { approvalButtons, duplicateButtons, isButtonSafeUrl, linkButton, sameIssueButtons, trackingButtons } from "../telegram/keyboards.js";
import type { FilingService, StatusService } from "../integrations/fallbacks.js";
import { RUNS_DIR } from "../integrations/env.js";
import { resolveEvidencePath } from "../services/evidence-registry.js";
import {
  MACHINERY_FIELDS,
  NOT_RAISED,
  RELATED_DEFAULTS,
  SAME_ISSUE,
  type SameIssueChoice,
  type SameIssueMatch,
  findSameIssue,
  sameIssueChoiceItem,
  sameIssueLabel,
  sameIssueQueryText,
  sameIssuePrompt,
  sameIssueStatus,
  type AskHint,
  askPrompt,
  fieldValue,
  memoryCardLine,
  parseLearnedAnswer,
  readAskPatterns,
  readRelated,
  relatedCardLines,
} from "../services/memory.js";
import { readyForApprovalItem, recallAfterCard } from "../services/agent-memory.js";

export type { FilingService, StatusService } from "../integrations/fallbacks.js";

export type OrchestratorDeps = {
  store: Store;
  tracer: Tracer;
  /** Agent memory (#4). Absent ⇒ no memory writes (reads fall back to the store). */
  memory?: AgentMemory | null;
  classifier: Classifier;
  location: LocationService;
  duplicates: DuplicateService;
  filing: FilingService;
  status?: StatusService;
  transport: Transport;
  /** Always "real" (official forms); kept optional for older callers. */
  target?: FilingTarget;
  /** Where Telegram media is downloaded (default .runs/media). */
  mediaDir?: string;
  /** Max approvals per chat per hour (design doc §18.5). */
  maxFilingsPerHour?: number;
  /** Live MTA alerts for a subway line (default: public GTFS-RT feed). */
  mtaAlerts?: (line: string) => Promise<MtaAlertsResult>;
  /**
   * Subway: when the rider gave a direction the MTA option table can't resolve, leave it for the filing worker
   * to ask live (same browser) instead of asking before approval. Default env SUBWAY_DIRECTION_DURING_FILING=1, else off.
   */
  directionDuringFiling?: boolean;
};

/** A live worker question waiting for the resident (in-memory, keyed by complaint id). */
type PendingQuestion = {
  chatId: string;
  complaintId: string;
  version: number;
  attemptId: string;
  question: WorkerQuestion;
  resolve: (a: WorkerAnswer | null) => void;
};

export type HandleOptions = {
  /** Override the transport for this event (API event endpoint). */
  transport?: Transport;
  /** Await the filing job before resolving (scripts/tests). Default false: filing runs in the background. */
  waitForFiling?: boolean;
};

type Ctx = { chatId: string; t: Transport; resident: Resident; opts: HandleOptions };

const TRANSIT_HINT = /\b(subway|train|trains|uptown|downtown|platform|station|mta|shuttle|[1-7]\s+line|express|local)\b/i;

export function looksLikeTransit(text: string): boolean {
  return TRANSIT_HINT.test(text);
}

const ADDRESS_HINT =
  /(\b\d+[a-z]?\s+[\w.'-]+(\s[\w.'-]+)?\s+(st|street|ave|avenue|av|blvd|boulevard|rd|road|pl|place|dr|drive|ln|lane|pkwy|parkway|ter|terrace|ct|court|way|hwy|broadway)\b)|(\s(&|and|at)\s.*\b(st|street|ave|avenue|blvd|rd|pl|broadway)\b)|\b(corner of|intersection|cross street)\b|\b(manhattan|brooklyn|bronx|queens|staten island)\b|\b(st|street|ave|avenue|blvd|broadway)\b.*\b(&|and|at)\b|\b\d{5}\b/i;

export function looksLikeAddress(text: string): boolean {
  return ADDRESS_HINT.test(text);
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { store, tracer, classifier, location, duplicates, filing } = deps;
  const memory = deps.memory ?? null;
  const target: FilingTarget = "real";
  const mediaRoot = deps.mediaDir ?? resolve(RUNS_DIR, "media");
  const maxPerHour = deps.maxFilingsPerHour ?? 6;
  const complaints = createComplaintService(store);
  const chains = new Map<string, Promise<void>>();
  const filingJobs = new Map<string, Promise<void>>();
  const approvalsLog = new Map<string, number[]>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const directionDuringFiling = deps.directionDuringFiling ?? process.env.SUBWAY_DIRECTION_DURING_FILING === "1";

  // ---------------------------------------------------------------- helpers
  async function send(ctx: Ctx, msg: Omit<OutboundMessage, "chatId">) {
    return tracer.span("telegram.respond", { "message.length": msg.text.length, "message.buttons": msg.buttons?.flat().length ?? 0 }, async (set) => {
      const res = await ctx.t.send({ parseMode: "HTML", ...msg, chatId: ctx.chatId });
      set("message.id", res.messageId ?? -1);
      return res;
    });
  }

  function typing(ctx: Ctx) {
    void ctx.t.typing?.(ctx.chatId).catch(() => {});
  }

  async function activeDraft(chatId: string): Promise<ComplaintDraft | null> {
    const c = await store.getActiveComplaint(chatId);
    return c && OPEN_STATES.includes(c.status) ? c : null;
  }

  async function openOrNewDraft(ctx: Ctx): Promise<ComplaintDraft> {
    const existing = await activeDraft(ctx.chatId);
    if (existing) return existing;
    const d = await complaints.newDraft(ctx.chatId, ctx.resident.id);
    const traceId = tracer.currentTraceId();
    return traceId ? store.saveComplaint({ ...d, traceId }) : d;
  }

  function reviewUrl(): string {
    return NYC311_CHECK_STATUS_URL;
  }

  function finishUrl(d: ComplaintDraft, o: FilingOutcome): string {
    if (isButtonSafeUrl(o.officialReceiptUrl)) return o.officialReceiptUrl!;
    if (effectiveTarget(d.category, target) === "real") return getCategory(d.category)?.officialFormUrl ?? NYC311_REPORT_URL;
    return NYC311_REPORT_URL;
  }

  function needsName(resident: Resident, category: string | null) {
    return requiresContactName(category, target) && !resident.contactName;
  }

  const fetchAlerts = deps.mtaAlerts ?? ((line: string) => getActiveAlertsForLine(line));
  /** Subway drafts we already asked "When did this happen?" (asked once; then we continue without a time). */
  const timeAsked = new Set<string>();

  const needsTransit = (d: ComplaintDraft) => requiredFieldsFor(d.category).includes("transit");
  /** The line is known but the direction is not (yet) one of the MTA form's two options for it. */
  function directionUnresolved(d: ComplaintDraft): boolean {
    const opts = mtaDirectionOptions(d.transit?.line);
    return !!opts && !opts.includes(d.transit?.direction ?? "");
  }

  /**
   * Subway: resolve line → direction (in the MTA form's own terms) → time, one question at a time.
   * Returns the updated draft, or null when a question was sent (draft is in NEEDS_INFORMATION).
   */
  async function resolveTransit(ctx: Ctx, draft: ComplaintDraft, prefix: string[]): Promise<ComplaintDraft | null> {
    const t = draft.transit;
    if (!t?.line) {
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: transit line");
      await send(ctx, { text: [...prefix, M.askTransit(["line"])].join("\n\n") });
      return null;
    }
    const opts = mtaDirectionOptions(t.line);
    if (opts && !opts.includes(t.direction ?? "")) {
      const hit = resolveDirection(t.line, t.direction);
      if (hit) draft = complaints.setTransit(draft, { direction: hit });
      else if (directionDuringFiling && t.direction?.trim()) {
        /* the worker asks live against the form's own options (browser.ask_resident) */
      } else {
        draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: direction");
        await send(ctx, {
          text: [...prefix, M.askDirection(t.line, t.direction)].join("\n\n"),
          buttons: opts.map((label, i) => [{ text: label, data: `${encodeCallback("set_direction", draft.id, draft.draftVersion)}:d=${i}` }]),
        });
        return null;
      }
    } else if (!opts && !t.direction?.trim()) {
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: transit direction");
      await send(ctx, { text: [...prefix, M.askTransit(["direction"])].join("\n\n") });
      return null;
    }
    if (!draft.transit?.incidentTime && !timeAsked.has(draft.id)) {
      timeAsked.add(draft.id);
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: time");
      await send(ctx, {
        text: [...prefix, M.askTime()].join("\n\n"),
        buttons: [
          [{ text: "Just now", data: `${encodeCallback("set_time", draft.id, draft.draftVersion)}:now` }],
          [{ text: "Earlier today — I'll type the time", data: `${encodeCallback("set_time", draft.id, draft.draftVersion)}:later` }],
        ],
      });
      return null;
    }
    return draft;
  }

  /** Live MTA alert corroboration for subway categories (the analogue of the Open Data duplicate check). */
  async function mtaAlertLine(draft: ComplaintDraft): Promise<string | null> {
    const line = draft.transit?.line;
    if (!line || isOpenDataBacked(draft.category)) return null;
    try {
      const r = await tracer.span("mta.live_alerts", { "transit.line": line, "complaint.id": draft.id }, async (set, oi) => {
        oi.input({ line });
        const res = await fetchAlerts(line);
        set("alerts.count", res.alerts.length);
        set("alerts.source", res.source);
        set("alerts.delay_match", res.alerts.some(isDelayAlert));
        oi.retriever(res.alerts.slice(0, 5).map((a) => ({ id: a.id || a.header.slice(0, 40), content: `${a.type}: ${a.header}`, score: isDelayAlert(a) ? 1 : 0.5, metadata: { type: a.type, routes: a.routes, active: a.active } })));
        return res;
      });
      if (r.source === "unavailable") return M.mtaAlertsDown();
      const hit = r.alerts.find(isDelayAlert);
      return hit ? M.mtaAlert(hit.header) : M.noMtaAlert(lineLabel(line));
    } catch (err) {
      console.warn("[orchestrator] mta alerts failed:", (err as Error).message);
      return null;
    }
  }

  // ------------------------------------------- SurrealDB memory (services/memory.ts)
  /** Learned questions already asked per draft (`<draftId>:<field>`), so a "skip" is never re-asked. */
  const learnedAsked = new Set<string>();
  const LEARNED = "missing: learned:";
  const gotIt = (v: string) => `Got it: <b>${esc(v)}</b>.`;

  /** A. Workflow memory: ask-before-approval patterns for this route (RETRIEVER span, patterns as documents). */
  async function loadAskHints(draft: ComplaintDraft): Promise<AskHint[]> {
    if (!draft.category) return [];
    const route = { target: effectiveTarget(draft.category, target), category: draft.category };
    try {
      return await tracer.span("surrealdb.read_context", { "query.kind": "workflow_pattern", "openinference.span.kind": "RETRIEVER", "filing.target": route.target, "complaint.category": route.category }, async (set, oi) => {
        oi.input(route);
        const { patterns, hints, docs } = await readAskPatterns(store, memory, route);
        set("patterns.count", patterns.length);
        set("patterns.ask_before_approval", hints.length);
        oi.retriever(docs);
        return hints;
      });
    } catch (err) {
      console.warn("[orchestrator] workflow patterns unavailable:", (err as Error).message);
      return [];
    }
  }

  /** Ask the first learned field that is still empty (one question at a time). Returns the draft when a question was sent. */
  async function askLearned(ctx: Ctx, draft: ComplaintDraft, hints: AskHint[], prefix: string[]): Promise<ComplaintDraft | null> {
    for (const h of hints) {
      const key = `${draft.id}:${h.field}`;
      if (learnedAsked.has(key)) continue;
      // Direction: reuse the MTA option-table question (buttons) when the rider's words don't resolve.
      if (h.field === "direction" && needsTransit(draft) && draft.transit?.line && directionUnresolved(draft)) {
        learnedAsked.add(key);
        const line = draft.transit.line;
        const said = draft.transit.direction;
        draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: direction");
        const opts = mtaDirectionOptions(line) ?? [];
        await send(ctx, {
          text: [...prefix, memoryCardLine([h]) ?? "", M.askDirection(line, said)].filter(Boolean).join("\n\n"),
          buttons: opts.map((label, i) => [{ text: label, data: `${encodeCallback("set_direction", draft.id, draft.draftVersion)}:d=${i}` }]),
        });
        return draft;
      }
      if (MACHINERY_FIELDS.has(h.field) || fieldValue(draft, ctx.resident, h.field)) continue;
      learnedAsked.add(key);
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", `${LEARNED}${h.field}`);
      await send(ctx, { text: [...prefix, askPrompt(h)].join("\n\n") });
      return draft;
    }
    return null;
  }

  /** Typed answer to a learned question. Returns true when consumed. */
  async function answerLearned(ctx: Ctx, draft: ComplaintDraft, text: string): Promise<boolean> {
    if (draft.status !== "NEEDS_INFORMATION" || !draft.statusReason?.startsWith(LEARNED)) return false;
    const field = draft.statusReason.slice(LEARNED.length);
    const h = (await loadAskHints(draft)).find((x) => x.field === field) ?? { field };
    const a = parseLearnedAnswer(h, text);
    switch (a.kind) {
      case "invalid":
        await send(ctx, { text: a.message });
        return true;
      case "skip":
        await advance(ctx, draft, ["OK, I'll leave that out."]);
        return true;
      case "transit":
        draft = await store.saveComplaint(complaints.setTransit(draft, a.patch));
        await advance(ctx, draft, [gotIt(a.patch.station)]);
        return true;
      case "resident":
        ctx.resident = await store.updateResident(ctx.resident.id, a.patch);
        await advance(ctx, draft, [gotIt(a.patch.contactName ?? a.patch.contactEmail ?? "")]);
        return true;
      case "extra":
        draft = await store.saveComplaint({ ...draft, extraFields: { ...(draft.extraFields ?? {}), [a.field]: a.value }, updatedAt: nowIso() });
        await advance(ctx, draft, [gotIt(a.value)]);
        return true;
    }
  }

  /** B. Remembered issues: your own recent report + other residents' (counts only). Also RELATEs similar_to edges. */
  async function relatedLines(ctx: Ctx, draft: ComplaintDraft): Promise<string[]> {
    if (!store.findRelatedComplaints || !draft.category) return [];
    const line = needsTransit(draft) ? (draft.transit?.line ?? null) : null;
    const lat = line ? null : draft.location.latitude;
    const lon = line ? null : draft.location.longitude;
    if (!line && (lat == null || lon == null)) return [];
    const q = { complaintId: draft.id, chatId: ctx.chatId, category: draft.category, line, lat, lon, ...RELATED_DEFAULTS };
    try {
      const r = await tracer.span("surrealdb.read_context", { "query.kind": "related_complaints", "openinference.span.kind": "RETRIEVER", "complaint.id": draft.id, "complaint.category": draft.category, "transit.line": line ?? "" }, async (set, oi) => {
        oi.input({ category: q.category, line, lat: lat != null ? Number(lat.toFixed(4)) : null, lon: lon != null ? Number(lon.toFixed(4)) : null, radiusMeters: q.radiusMeters, sinceMs: q.sinceMs, othersSinceMs: q.othersSinceMs });
        // #22: the card never waits for recall (embedding the draft text); recallAfterCard() decorates afterwards
        const { related: res, docs } = await readRelated(store, null, q, readyForApprovalItem(draft).text);
        set("related.mine", res.mine.length);
        set("related.others_reports", res.others.reports);
        set("related.others_residents", res.others.residents);
        oi.retriever(docs);
        return res;
      });
      const ids = [...r.mine.map((m) => m.id), ...r.others.ids];
      if (ids.length) await store.linkSimilarComplaints?.(draft.id, ids).catch((e) => console.warn("[orchestrator] linkSimilarComplaints:", (e as Error).message));
      return relatedCardLines(q, r);
    } catch (err) {
      console.warn("[orchestrator] related complaints unavailable:", (err as Error).message);
      return [];
    }
  }

  // ------------------------------------- #5 same issue already raised by another resident
  const SAME_ISSUE_REASON = "same issue as ";
  /** The original a DUPLICATE_REVIEW draft was matched to (set by our own code in statusReason, never by a callback). */
  const sameIssueOriginal = (d: ComplaintDraft) => (d.status === "DUPLICATE_REVIEW" && d.statusReason?.startsWith(SAME_ISSUE_REASON) ? d.statusReason.slice(SAME_ISSUE_REASON.length) : null);

  /** Episodic memory recall across residents (RETRIEVER span; the match is documented without any resident ids). */
  async function sameIssueCheck(draft: ComplaintDraft): Promise<SameIssueMatch | null> {
    if (!memory || !draft.category || draft.sameIssueAs) return null;
    try {
      return await tracer.span("memory.same_issue", { "openinference.span.kind": "RETRIEVER", "complaint.id": draft.id, "complaint.category": draft.category, "transit.line": draft.transit?.line ?? "", "same_issue.threshold": SAME_ISSUE.threshold }, async (set, oi) => {
        const m = await findSameIssue({ store, memory }, draft);
        set("same_issue.matched", !!m);
        if (m) {
          set("same_issue.score", m.breakdown.score);
          set("same_issue.recent_reporters", m.recentReporters);
          set("same_issue.supporters", m.supporters);
          oi.retriever([{ id: m.originalId, content: sameIssueLabel(m), score: m.breakdown.score, metadata: { memoryId: m.memoryId, status: m.status, timeBucket: m.timeBucket, ...m.breakdown } }]);
        }
        return m;
      });
    } catch (err) {
      console.warn("[orchestrator] same-issue check unavailable:", (err as Error).message);
      return null;
    }
  }

  function rememberChoice(draft: ComplaintDraft, originalId: string, choice: SameIssueChoice) {
    if (memory) void memory.remember(sameIssueChoiceItem(draft, originalId, choice)).catch((e) => console.warn("[orchestrator] memory (same issue):", (e as Error).message));
  }

  /** "Add me to the existing report": a lightweight complaint in TRACKING, linked ->same_issue_as-> the original. Nothing is filed. */
  async function joinSameIssue(ctx: Ctx, draft: ComplaintDraft, originalId: string) {
    const original = await store.getComplaint(originalId);
    if (!original || NOT_RAISED.includes(original.status)) {
      await store.linkNotSameIssue?.(draft.id, originalId).catch(() => null);
      return void (await advance(ctx, draft, [M.sameIssueGone()]));
    }
    let supporters = 0;
    draft = await tracer.span("user.same_issue_join", { "complaint.id": draft.id, "same_issue.original_id": originalId }, async (set) => {
      let d = await store.saveComplaint({ ...draft, sameIssueAs: originalId, duplicateReviewed: true });
      d = await transition(store, d, "TRACKING", { reason: `joined existing report ${originalId} (same issue)`, actor: "user" });
      supporters = (await store.linkSameIssue?.(d.id, originalId).catch((e) => (console.warn("[orchestrator] linkSameIssue:", (e as Error).message), 0))) ?? 0;
      set("same_issue.supporters", supporters);
      return d;
    });
    rememberChoice(draft, originalId, "join");
    const label = sameIssueLabel({ category: original.category!, line: original.transit?.line ?? null, direction: original.transit?.direction ?? null, station: original.transit?.station ?? null });
    await send(ctx, { text: M.sameIssueJoined(label, sameIssueStatus({ status: original.status, officialRequestNumber: original.officialRequestNumber, category: original.category! }), supporters) });
  }

  // ------------------------------------------------------------ the pipeline
  /** After any update to an open draft: decide the next state and message. */
  async function advance(ctx: Ctx, draft: ComplaintDraft, prefix: string[] = []): Promise<ComplaintDraft> {
    draft = complaints.computeMissing(draft);
    if (draft.status !== "TRIAGING") draft = await complaints.enterTriage(draft, "re-evaluate draft");
    else draft = await store.saveComplaint(draft);

    if (draft.missingFields.includes("category") || draft.missingFields.includes("description")) {
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", `missing: ${draft.missingFields.join(",")}`);
      const q = draft.classification?.clarifyingQuestion ?? null;
      await send(ctx, { text: [...prefix, draft.missingFields.includes("category") ? M.clarify(q) : M.needDescription()].join("\n\n") });
      return draft;
    }
    if (needsTransit(draft)) {
      const resolved = await resolveTransit(ctx, draft, prefix);
      if (!resolved) return (await store.getComplaint(draft.id)) ?? draft;
      draft = resolved;
    }
    if (draft.missingFields.includes("location")) {
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: location");
      await send(ctx, { text: [...prefix, M.askLocation()].join("\n\n"), requestLocation: true });
      return draft;
    }

    // [memory] Ask what earlier filings stalled on, before READY_FOR_APPROVAL (workflow_pattern "ask-before-approval").
    const hints = await loadAskHints(draft);
    const asked = await askLearned(ctx, draft, hints, prefix);
    if (asked) return asked;

    // [memory #5] Already raised by another resident? Ask before the approval card (join it, or file a new one).
    const same = await sameIssueCheck(draft);
    if (same) {
      draft = await complaints.moveTo(draft, "DUPLICATE_REVIEW", `${SAME_ISSUE_REASON}${same.originalId}`);
      await send(ctx, { text: [...prefix, sameIssuePrompt(same)].join("\n\n"), buttons: sameIssueButtons(draft) });
      return draft;
    }

    // Complete → duplicate check (once per location/category). Not for categories without Open Data (subway → MTA).
    const notes: string[] = [...prefix];
    if (!isOpenDataBacked(draft.category)) {
      if (!draft.duplicateReviewed) {
        notes.push(M.noDuplicateCheckMta());
        draft = { ...draft, duplicateReviewed: true, duplicates: [], duplicatesDataAsOf: null };
      }
    } else if (!draft.duplicateReviewed && draft.category && draft.location.latitude != null && draft.location.longitude != null) {
      const lat = draft.location.latitude;
      const lon = draft.location.longitude;
      const category = draft.category;
      let found: Awaited<ReturnType<DuplicateService["findPotentialDuplicates"]>> | null = null;
      try {
        found = await tracer.span("nyc311.search_duplicates", { category, "geo.radius_m": 50 }, async (set, oi) => {
          oi.input({ category, lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) });
          const r = await duplicates.findPotentialDuplicates({ category, latitude: lat, longitude: lon });
          set("duplicates.count", r.candidates.length);
          set("duplicates.source", r.source);
          oi.retriever(r.candidates.map((c) => ({ id: c.uniqueKey, content: `${c.complaintType} / ${c.descriptor ?? ""} / ${c.status ?? ""}`, score: c.matchScore })));
          return r;
        });
      } catch (err) {
        console.warn("[orchestrator] duplicate search failed:", (err as Error).message);
      }
      if (!found || found.source === "unavailable") {
        notes.push(M.openDataDown());
        draft = { ...draft, duplicateReviewed: true, duplicates: [], duplicatesDataAsOf: null };
      } else if (found.candidates.length > 0) {
        draft = { ...draft, duplicates: found.candidates, duplicatesDataAsOf: found.dataAsOf };
        await store.linkDuplicates(draft.id, found.candidates).catch((e) => console.warn("[orchestrator] linkDuplicates:", e.message));
        draft = await complaints.moveTo(draft, "DUPLICATE_REVIEW", `${found.candidates.length} potential duplicate(s)`);
        const label = getCategory(draft.category)?.label ?? "street";
        const text = [...notes, M.duplicate(found.candidates, found.dataAsOf, label)].join("\n\n");
        await send(ctx, { text, buttons: duplicateButtons(draft, reviewUrl()) });
        return draft;
      } else {
        draft = { ...draft, duplicateReviewed: true, duplicates: [], duplicatesDataAsOf: found.dataAsOf };
      }
    }
    return presentDraft(ctx, draft, notes, "system", hints);
  }

  async function presentDraft(ctx: Ctx, draft: ComplaintDraft, notes: string[] = [], actor: "system" | "user" = "system", knownHints?: AskHint[]): Promise<ComplaintDraft> {
    if (draft.status !== "READY_FOR_APPROVAL") draft = await complaints.moveTo(draft, "READY_FOR_APPROVAL", "draft complete", actor);
    const realOnly = isRealOnly(draft.category);
    const [alertLine, related, hints] = await Promise.all([realOnly ? mtaAlertLine(draft) : Promise.resolve(null), relatedLines(ctx, draft), knownHints ? Promise.resolve(knownHints) : loadAskHints(draft)]);
    const memoLine = memoryCardLine(hints);
    const contextLines = [...related, ...(memoLine ? [memoLine] : [])];
    const summary = await tracer.span("draft.generate", { "complaint.id": draft.id, "draft.version": draft.draftVersion }, async (_set, oi) => {
      const real = effectiveTarget(draft.category, target) === "real";
      const s = complaints.buildSummary(draft, {
        contactName: real ? ctx.resident.contactName : null,
        contactEmail: realOnly ? ctx.resident.contactEmail : null,
        target: effectiveTarget(draft.category, target),
        alertLine,
        contextLines,
      });
      oi.output({ category: draft.category, version: draft.draftVersion, photos: draft.media.length, transit: draft.transit ?? null });
      // [memory] episodic: this draft reached READY_FOR_APPROVAL (neutral description + transit facts; upserted per complaint; never blocks the card)
      if (memory) void memory.remember(readyForApprovalItem(draft)).catch((e) => console.warn("[orchestrator] memory (ready):", (e as Error).message));
      return s;
    });
    const parts = [...notes, summary];
    const blocked = needsName(ctx.resident, draft.category);
    if (blocked) parts.push(M.needName());
    await send(ctx, { text: parts.join("\n\n"), buttons: approvalButtons(draft, { canApprove: !blocked }) });
    // [memory] #22: recall after the card (memory.recall span + /api/memory cache); never awaited
    if (memory) void recallAfterCard(memory, draft);
    return draft;
  }

  async function classifyAndAdvance(ctx: Ctx, draft: ComplaintDraft, input: { text: string | null; imagePaths: string[] }, prefix: string[] = []) {
    draft = await complaints.enterTriage(draft, "new input");
    typing(ctx);
    let result: ClassificationResult | null = null;
    try {
      const r = await tracer.span("routing.classify", { "input.has_image": input.imagePaths.length > 0, "input.text_length": input.text?.length ?? 0 }, async (set, oi) => {
        const out = await classifier.classify({
          text: input.text,
          imagePaths: input.imagePaths,
          priorDescription: draft.description || null,
          locationKnown: !draft.missingFields.includes("location") || draft.location.userConfirmed,
          conversation: draft.userMessages,
        });
        set("classification.triage", out.result.triage);
        set("classification.category", out.result.category ?? "none");
        set("classification.confidence", out.result.confidence);
        set("llm.model_name", out.model);
        oi.output(out.result);
        return out;
      });
      result = r.result;
    } catch (err) {
      console.warn("[orchestrator] classify failed:", (err as Error).message);
    }

    if (!result) {
      if (draft.category) return advance(ctx, draft, prefix);
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "classifier unavailable");
      await send(ctx, { text: [...prefix, input.imagePaths.length ? M.invalidImage() : M.clarify(null)].join("\n\n") });
      return draft;
    }

    const hadCategory = draft.category;
    const applied = complaints.applyClassification(draft, result);
    draft = applied.draft;
    // #5/#22: start embedding the same-issue query now (fire-and-forget) so the duplicate gate that runs
    // just before the card finds the vector in cache instead of waiting on OpenRouter.
    if (draft.category && memory?.warm) memory.warm(sameIssueQueryText(draft));
    // Deterministic fallback for short answers to the line/direction question ("the A", "downtown").
    if (input.text && requiredFieldsFor(draft.category).includes("transit") && missingTransit(draft.transit).length && applied.decision.kind === "CONTINUE") {
      const hints = transitHintsFromText(input.text);
      const missing = missingTransit(draft.transit);
      const patch = { ...(missing.includes("line") && hints.line ? { line: hints.line } : {}), ...(missing.includes("direction") && hints.direction ? { direction: hints.direction } : {}) };
      if (Object.keys(patch).length) draft = complaints.setTransit(draft, patch);
    }
    switch (applied.decision.kind) {
      case "EMERGENCY": {
        draft = await transition(store, draft, "EMERGENCY_REFERRAL", { reason: `safety: ${result.safetyFlags.join(", ") || "danger"}`, actor: "llm" });
        tracer.evaluate("emergency_referral", { label: "referred", explanation: result.rationale });
        await send(ctx, { text: M.emergency() });
        return draft;
      }
      case "OUT_OF_SCOPE": {
        draft = await transition(store, draft, "OUT_OF_SCOPE", { reason: "unsupported category", actor: "llm" });
        await send(ctx, { text: M.outOfScope("OUT_OF_SCOPE", result.description), buttons: linkButton("Report on NYC311", NYC311_REPORT_URL) });
        return draft;
      }
      case "CLARIFY": {
        draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "low confidence / unclear");
        await send(ctx, { text: [...prefix, M.clarify(applied.decision.question)].join("\n\n") });
        return draft;
      }
      case "CONTINUE": {
        const label = getCategory(draft.category)?.label;
        const pre = [...prefix];
        if (label && hadCategory !== draft.category) pre.push(M.classified(label));
        else if (hadCategory && input.text) pre.push(M.noted());
        return advance(ctx, draft, pre);
      }
    }
  }

  function photoPaths(d: ComplaintDraft) {
    return d.media.filter((m) => m.type === "photo" && m.localPath).map((m) => m.localPath!).slice(-3);
  }

  // --------------------------------------------------------------- handlers
  async function onPhoto(ctx: Ctx, ev: Extract<InboundEvent, { kind: "photo" }>) {
    let draft = await openOrNewDraft(ctx);
    const media = await tracer.span("intake.extract", { "input.kind": "photo", "input.has_caption": !!ev.caption }, async (set) => {
      const dir = resolve(mediaRoot, ctx.chatId);
      mkdirSync(dir, { recursive: true });
      try {
        const file = await ctx.t.downloadFile(ev.fileId, dir);
        set("media.downloaded", true);
        const item: MediaItem = { id: shortId("med"), type: "photo", telegramFileId: ev.fileId, localPath: file.path, mime: file.mime, createdAt: nowIso() };
        return item;
      } catch (err) {
        set("media.downloaded", false);
        console.warn("[orchestrator] photo download failed:", (err as Error).message);
        return null;
      }
    });
    if (media) draft = { ...draft, media: [...draft.media, media] };
    if (ev.caption?.trim()) draft = { ...draft, userMessages: [...draft.userMessages, ev.caption.trim()] };
    draft = await store.saveComplaint(draft);
    if (!media && !ev.caption) {
      await send(ctx, { text: M.invalidImage() });
      return;
    }
    await send(ctx, { text: M.analyzing() });
    await classifyAndAdvance(ctx, draft, { text: ev.caption ?? null, imagePaths: photoPaths(draft) });
  }

  async function applyLocation(ctx: Ctx, draft: ComplaintDraft, loc: ComplaintLocation) {
    if (loc.withinNyc === false) {
      if (draft.status !== "NEEDS_INFORMATION") draft = await complaints.enterTriage(draft, "location outside NYC");
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "location outside NYC");
      await send(ctx, { text: M.outsideNyc(), requestLocation: true });
      return draft;
    }
    draft = complaints.setLocation(draft, { ...loc, userConfirmed: true });
    await store.upsertLocation(draft.location).catch(() => null);
    draft = await store.saveComplaint(draft);
    if (!draft.description && !draft.media.length) {
      draft = await complaints.enterTriage(draft, "location before description");
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing description");
      await send(ctx, { text: `Got the location. 📍\n\n${M.needDescription()}` });
      return draft;
    }
    return advance(ctx, draft, [M.locationGot()]);
  }

  async function onLocation(ctx: Ctx, ev: Extract<InboundEvent, { kind: "location" }>) {
    const draft = await openOrNewDraft(ctx);
    const loc = await tracer.span("location.validate", { "location.source": "pin" }, async (set) => {
      const l = await location.fromPin(ev.latitude, ev.longitude);
      set("location.within_nyc", l.withinNyc ?? false);
      set("location.has_address", !!l.address);
      return l;
    });
    await applyLocation(ctx, draft, loc);
  }

  async function onText(ctx: Ctx, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    let draft = await openOrNewDraft(ctx);
    // [memory] typed answer to a question learned from earlier filings
    if (await answerLearned(ctx, draft, trimmed)) return;
    // Subway: direct answers to our own direction / time questions are resolved deterministically (no LLM round trip).
    if (draft.status === "NEEDS_INFORMATION" && needsTransit(draft) && draft.transit?.line) {
      if (draft.statusReason === "missing: direction" && directionUnresolved(draft)) {
        const hit = resolveDirection(draft.transit.line, trimmed);
        if (hit) {
          draft = await store.saveComplaint(complaints.setTransit(draft, { direction: hit }));
          await advance(ctx, draft, [M.directionSet(hit)]);
          return;
        }
      }
      if (draft.statusReason === "missing: time" && !draft.transit.incidentTime) {
        const iso = parseIncidentTime(trimmed);
        if (iso) {
          draft = await store.saveComplaint(complaints.setTransit(draft, { incidentTime: iso }));
          await advance(ctx, draft, [M.timeSet(fmtIncidentTime(iso) ?? trimmed)]);
          return;
        }
        if (/^(skip|no|not sure|don'?t know|idk|dunno|unknown)\b/i.test(trimmed)) {
          await advance(ctx, draft);
          return;
        }
      }
    }
    const lacksLocation = !draft.location.userConfirmed || draft.location.withinNyc === false || draft.statusReason === "user requested edit";
    // Subway reports mention stations ("at 14 St") that look like addresses: they are transit details, not a 311 location.
    // Only categories whose requiredFields include "location" ask for one (none today; the code path stays for later).
    const anyLocationCategory = allCategories().some((c) => c.requiredFields.includes("location"));
    const wantsLocation = draft.category ? requiredFieldsFor(draft.category).includes("location") : anyLocationCategory && !looksLikeTransit(trimmed);
    if (wantsLocation && lacksLocation && looksLikeAddress(trimmed)) {
      const loc = await tracer.span("location.validate", { "location.source": "text" }, async (set) => {
        const l = await location.fromText(trimmed).catch(() => null);
        set("location.resolved", !!l);
        if (l) set("location.within_nyc", l.withinNyc ?? false);
        return l;
      });
      if (loc) {
        await applyLocation(ctx, draft, { ...loc, rawInput: loc.rawInput ?? trimmed, source: "text" });
        return;
      }
    }
    draft = await tracer.span("intake.extract", { "input.kind": "text", "input.length": trimmed.length }, async () =>
      store.saveComplaint({ ...draft, userMessages: [...draft.userMessages, trimmed] }),
    );
    await classifyAndAdvance(ctx, draft, { text: trimmed, imagePaths: photoPaths(draft) });
  }

  async function onVoice(ctx: Ctx, ev: Extract<InboundEvent, { kind: "voice" }>) {
    if (!classifier.transcribe) {
      await send(ctx, { text: M.voiceUnsupported() });
      return;
    }
    const transcript = await tracer.span("intake.extract", { "input.kind": "voice" }, async () => {
      const dir = resolve(mediaRoot, ctx.chatId);
      mkdirSync(dir, { recursive: true });
      const f = await ctx.t.downloadFile(ev.fileId, dir);
      return classifier.transcribe!(f.path);
    }).catch((err) => {
      console.warn("[orchestrator] transcription failed:", (err as Error).message);
      return null;
    });
    if (!transcript) {
      await send(ctx, { text: M.voiceUnsupported() });
      return;
    }
    await send(ctx, { text: `🎙️ I heard: “${transcript.replace(/[<>&]/g, "")}”` });
    await onText(ctx, transcript);
  }

  // ---------------------------------------------------------------- commands
  async function onCommand(ctx: Ctx, command: string, args: string) {
    switch (command.toLowerCase()) {
      case "start":
        await send(ctx, { text: M.start() });
        return;
      case "help":
        await send(ctx, { text: M.help() });
        return;
      case "report": {
        const d = await activeDraft(ctx.chatId);
        if (d) await complaints.cancel(d, "user").catch(() => null);
        await send(ctx, { text: M.reportPrompt() });
        return;
      }
      case "cancel": {
        const d = await store.getActiveComplaint(ctx.chatId);
        if (!d || !canTransition(d.status, "CANCELLED")) {
          await send(ctx, { text: d?.status === "FILING" ? "Filing is in progress, so I can't cancel it right now. I'll report back shortly." : M.nothingToCancel() });
          return;
        }
        await complaints.cancel(d, "user");
        await send(ctx, { text: M.cancelled() });
        return;
      }
      case "myreports": {
        const [list, reqs] = await tracer.span("surrealdb.read_context", { "query.kind": "myreports" }, async () =>
          Promise.all([store.listComplaints({ chatId: ctx.chatId, limit: 20 }), store.listOfficialRequests(ctx.chatId)]),
        );
        const visible = list.filter((c) => c.status !== "CANCELLED" || c.officialRequestNumber);
        // #5: joined issues show the original's status (never anything about its resident)
        const supported: Record<string, string> = {};
        for (const c of visible.slice(0, 5)) {
          if (!c.sameIssueAs) continue;
          const o = await store.getComplaint(c.sameIssueAs).catch(() => null);
          if (o?.category) supported[c.id] = sameIssueStatus({ status: o.status, officialRequestNumber: o.officialRequestNumber, category: o.category });
        }
        await send(ctx, { text: M.myReports(visible, reqs, supported) });
        return;
      }
      case "status": {
        let sr = args.trim().split(/\s+/)[0] ?? "";
        if (!sr) {
          const list = await store.listComplaints({ chatId: ctx.chatId, limit: 20 });
          sr = list.find((c) => c.officialRequestNumber)?.officialRequestNumber ?? "";
        }
        if (!sr) {
          await send(ctx, { text: M.statusUsage() });
          return;
        }
        await replyStatus(ctx, sr);
        return;
      }
      case "email": {
        const email = args.trim();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) {
          await send(ctx, { text: M.emailUsage() });
          return;
        }
        ctx.resident = await store.updateResident(ctx.resident.id, { contactEmail: email });
        await send(ctx, { text: M.emailSaved(email) });
        const d = await activeDraft(ctx.chatId);
        if (d?.status === "READY_FOR_APPROVAL") await presentDraft(ctx, d);
        return;
      }
      case "name": {
        const name = args.trim().replace(/\s+/g, " ");
        if (name.split(" ").length < 2 || name.length > 80) {
          await send(ctx, { text: "Please send your first and last name, like <code>/name Jane Doe</code>." });
          return;
        }
        ctx.resident = await store.updateResident(ctx.resident.id, { contactName: name });
        await send(ctx, { text: M.nameSaved(name) });
        const d = await activeDraft(ctx.chatId);
        if (d?.status === "READY_FOR_APPROVAL") await presentDraft(ctx, d);
        return;
      }
      default:
        await send(ctx, { text: M.help() });
    }
  }

  async function replyStatus(ctx: Ctx, sr: string) {
    // MTA complaints: no public status feed; answer from the stored record.
    {
      const reqs = await tracer.span("surrealdb.read_context", { "query.kind": "official_request" }, async () => store.listOfficialRequests(ctx.chatId).catch(() => [] as OfficialRequest[]));
      const r = reqs.find((x) => x.officialRequestNumber.toUpperCase() === sr.toUpperCase());
      const c = r ? await store.getComplaint(r.complaintId) : null;
      if (r && c && !isOpenDataBacked(c.category)) {
        const filed = new Date(c.approvedAt ?? r.lastCheckedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
        await send(ctx, { text: M.mtaStatus(r.officialRequestNumber, filed) });
        return;
      }
    }
    const res = await tracer.span("nyc311.status_lookup", { "sr.length": sr.length }, async (set) => {
      if (!deps.status) return null;
      const r = await deps.status.lookup(sr, { target }).catch((err) => {
        console.warn("[orchestrator] status lookup failed:", (err as Error).message);
        return null;
      });
      set("status.found", !!r?.found);
      return r;
    });
    const norm = normalizeStatus(res);
    await send(ctx, { text: M.status(sr, norm) });
    if (norm.found && norm.status) {
      const list = await store.listComplaints({ chatId: ctx.chatId, limit: 50 });
      const c = list.find((x) => x.officialRequestNumber === sr);
      if (c) {
        const reqs = await store.listOfficialRequests(ctx.chatId);
        const existing = reqs.find((r) => r.officialRequestNumber === sr);
        if (existing) await store.saveOfficialRequest({ ...existing, status: norm.status, lastCheckedAt: nowIso() }).catch(() => null);
      }
    }
  }

  // --------------------------------------------------------------- callbacks
  async function onCallback(ctx: Ctx, ev: Extract<InboundEvent, { kind: "callback" }>) {
    const cb = decodeCallback(ev.data);
    if (!cb) return;
    let draft = await tracer.span("surrealdb.read_context", { "query.kind": "complaint" }, async () => store.getComplaint(cb.complaintId));
    if (!draft || draft.telegramChatId !== ctx.chatId) {
      await send(ctx, { text: "I couldn't find that report anymore. Send a photo or description to start a new one." });
      return;
    }
    switch (cb.action) {
      case "approve":
        return onApprove(ctx, draft, cb.version);
      case "edit": {
        if (!OPEN_STATES.includes(draft.status) && !["FAILED", "HUMAN_ACTION_REQUIRED"].includes(draft.status)) {
          await send(ctx, { text: `This report is already ${M_status(draft)}, so it can't be edited.` });
          return;
        }
        await complaints.editRequest(draft);
        await send(ctx, { text: M.editPrompt(requiredFieldsFor(draft.category).includes("transit")) });
        return;
      }
      case "cancel": {
        if (!canTransition(draft.status, "CANCELLED")) {
          await send(ctx, { text: `This report is already ${M_status(draft)}.` });
          return;
        }
        await complaints.cancel(draft, "user");
        await send(ctx, { text: M.cancelled() });
        return;
      }
      case "dup_review":
        await send(ctx, { text: `${M.dupReview()}\n\n${NYC311_CHECK_STATUS_URL}`, buttons: [[{ text: "➡️ Continue with new report", data: `dup_continue:${draft.id}:${draft.draftVersion}` }]] });
        return;
      case "dup_continue": {
        if (draft.status !== "DUPLICATE_REVIEW") {
          if (draft.status === "READY_FOR_APPROVAL") await presentDraft(ctx, draft);
          else await send(ctx, { text: `This report is ${M_status(draft)}.` });
          return;
        }
        if (cb.version !== draft.draftVersion) {
          await send(ctx, { text: M.draftChanged() });
          return void (await advance(ctx, draft));
        }
        const sameAs = sameIssueOriginal(draft);
        if (sameAs) {
          // #5 "It's different — file a new one": remember it (->not_same_as->) so we don't ask about that report again.
          await store.linkNotSameIssue?.(draft.id, sameAs).catch((e) => console.warn("[orchestrator] linkNotSameIssue:", (e as Error).message));
          rememberChoice(draft, sameAs, "different");
          if (isOpenDataBacked(draft.category) && !draft.duplicateReviewed) return void (await advance(ctx, draft, [M.sameIssueDifferent()]));
          draft = await tracer.span("user.same_issue_different", { "complaint.id": draft.id, "same_issue.original_id": sameAs }, async () =>
            transition(store, { ...draft!, duplicateReviewed: true }, "READY_FOR_APPROVAL", { reason: `user said it's different from ${sameAs}`, actor: "user" }),
          );
          await presentDraft(ctx, draft, [M.sameIssueDifferent()], "user");
          return;
        }
        draft = { ...draft, duplicateReviewed: true };
        draft = await tracer.span("user.duplicate_continue", { "complaint.id": draft.id }, async () =>
          transition(store, draft!, "READY_FOR_APPROVAL", { reason: "user chose to continue despite duplicates", actor: "user" }),
        );
        await presentDraft(ctx, draft, [], "user");
        return;
      }
      case "dup_join": {
        const originalId = sameIssueOriginal(draft);
        if (!originalId) {
          await send(ctx, { text: draft.sameIssueAs ? "You're already added to that report. /myreports shows its status." : `This report is ${M_status(draft)}.` });
          return;
        }
        if (cb.version !== draft.draftVersion) {
          await send(ctx, { text: M.draftChanged() });
          return void (await advance(ctx, draft));
        }
        await joinSameIssue(ctx, draft, originalId);
        return;
      }
      case "status": {
        if (!draft.officialRequestNumber) {
          await send(ctx, { text: `This report doesn't have an official request number. Status: <b>${M_status(draft)}</b>.` });
          return;
        }
        await replyStatus(ctx, draft.officialRequestNumber);
        return;
      }
      case "view_official": {
        const reqs = await store.listOfficialRequests(ctx.chatId);
        const r = reqs.find((x) => x.complaintId === draft!.id);
        const sr = r?.officialRequestNumber ?? draft.officialRequestNumber ?? "-";
        const shot = await confirmationScreenshot(draft);
        if (shot) {
          await send(ctx, { text: `Confirmation page for service request <b>${sr}</b>, captured by the filing worker.`, photoPath: shot });
          return;
        }
        const url = r?.receiptUrl ?? NYC311_CHECK_STATUS_URL;
        await send(ctx, { text: `Service request <b>${sr}</b>\n${url}` });
        return;
      }
      case "set_direction":
      case "set_time": {
        if (!OPEN_STATES.includes(draft.status) || !needsTransit(draft) || !draft.transit?.line) {
          await send(ctx, { text: `This report is ${M_status(draft)}.` });
          return;
        }
        if (cb.version !== draft.draftVersion) {
          await send(ctx, { text: M.draftChanged() });
          return void (await advance(ctx, draft));
        }
        const suffix = ev.data.split(":").slice(3).join(":");
        if (cb.action === "set_direction") {
          const opts = mtaDirectionOptions(draft.transit.line);
          const idx = Number(/^d=(\d)$/.exec(suffix)?.[1] ?? -1);
          const label = opts?.[idx];
          if (!label) return void (await advance(ctx, draft));
          draft = await store.saveComplaint(complaints.setTransit(draft, { direction: label }));
          await advance(ctx, draft, [M.directionSet(label)]);
          return;
        }
        if (suffix === "now") {
          const iso = nycIso();
          draft = await store.saveComplaint(complaints.setTransit(draft, { incidentTime: iso }));
          await advance(ctx, draft, [M.timeSet(fmtIncidentTime(iso) ?? "just now")]);
          return;
        }
        draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: time");
        await send(ctx, { text: M.askTimeTyped() });
        return;
      }
      case "answer_q":
        // Live answers are consumed in handle() while the question is pending; anything reaching here is stale.
        await send(ctx, { text: "That question is no longer open — the filing has already moved on." });
        return;
      case "retry_location":
        await send(ctx, { text: M.askLocation(), requestLocation: true });
        return;
      case "confirm_location":
        if (OPEN_STATES.includes(draft.status)) await advance(ctx, draft);
        return;
    }
  }

  async function confirmationScreenshot(d: ComplaintDraft): Promise<string | null> {
    const attempts = d.activeAttemptId ? [await store.getAttempt(d.activeAttemptId)] : await store.listAttempts({ complaintId: d.id, limit: 5 });
    for (const a of attempts) {
      if (!a) continue;
      const shots = a.evidence.filter((e) => e.type === "screenshot");
      const ev = [...shots].reverse().find((e) => e.step === "confirm") ?? shots[shots.length - 1];
      const hit = ev ? resolveEvidencePath(ev.id) : null;
      if (hit) return hit.path;
    }
    return null;
  }

  function M_status(d: ComplaintDraft) {
    return d.status.toLowerCase().replace(/_/g, " ");
  }

  function rateLimited(chatId: string): boolean {
    const now = Date.now();
    const list = (approvalsLog.get(chatId) ?? []).filter((t) => now - t < 3600_000);
    approvalsLog.set(chatId, list);
    return list.length >= maxPerHour;
  }

  async function onApprove(ctx: Ctx, draft: ComplaintDraft, version: number) {
    if (draft.status === "APPROVED" || draft.status === "FILING" || filingJobs.has(draft.id)) {
      await send(ctx, { text: M.busy() });
      return;
    }
    if (draft.status !== "READY_FOR_APPROVAL") {
      await send(ctx, { text: `This report is ${M_status(draft)}, so there's nothing to approve.` });
      return;
    }
    if (version !== draft.draftVersion) {
      await send(ctx, { text: M.draftChanged() });
      await presentDraft(ctx, draft);
      return;
    }
    if (needsName(ctx.resident, draft.category)) {
      await send(ctx, { text: M.needName() });
      return;
    }
    if (rateLimited(ctx.chatId)) {
      await send(ctx, { text: "You've filed several reports in the last hour. To avoid flooding NYC311, please wait a bit before filing another." });
      return;
    }
    const res = await tracer.span("user.approve", { "complaint.id": draft.id, "draft.version": version }, async (set) => {
      const r = await complaints.approve(draft, version, "user");
      set("approval.ok", r.ok);
      if (!r.ok) set("approval.reason", r.reason);
      return r;
    });
    if (!res.ok) {
      await send(ctx, { text: M.draftChanged() });
      const fresh = await store.getComplaint(draft.id);
      if (fresh?.status === "READY_FOR_APPROVAL") await presentDraft(ctx, fresh);
      return;
    }
    approvalsLog.set(ctx.chatId, [...(approvalsLog.get(ctx.chatId) ?? []), Date.now()]);
    await send(ctx, { text: M.filingNow() });
    const job = runFiling(ctx, res.draft).finally(() => filingJobs.delete(draft.id));
    filingJobs.set(draft.id, job);
    if (ctx.opts.waitForFiling) await job;
  }

  async function runFiling(ctx: Ctx, approved: ComplaintDraft) {
    // Progress: one message, edited in place (falls back to new messages if editing fails).
    const lines: string[] = [];
    let progressId: number | null = null;
    let last = "";
    let lastBody = "";
    let lastSentAt = 0;
    let chain: Promise<void> = Promise.resolve();
    const flush = async () => {
      const body = lines.slice(-8).map((l) => M.progress(l)).join("\n");
      if (!body || body === lastBody) return; // coalesced into a later edit
      const wait = 1100 - (Date.now() - lastSentAt); // stay under Telegram's edit rate limits
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const latest = lines.slice(-8).map((l) => M.progress(l)).join("\n");
      if (latest === lastBody) return;
      lastBody = latest;
      lastSentAt = Date.now();
      const r = await ctx.t.send({ chatId: ctx.chatId, text: latest, parseMode: "HTML", ...(progressId != null ? { editMessageId: progressId } : {}) });
      if (r.messageId != null) progressId = r.messageId;
    };
    const onProgress = (text: string) => {
      const clean = String(text).replace(/https?:\/\/\S+/g, "[link]").slice(0, 200);
      if (!clean || clean === last) return;
      last = clean;
      lines.push(clean);
      chain = chain.then(flush).catch((err) => console.warn("[orchestrator] progress send failed:", (err as Error).message));
    };

    let outcome: FilingOutcome;
    // The recording arrives in the background (10–90 s after the browser closes); always after the outcome message.
    let outcomeSent!: () => void;
    const outcomeShown = new Promise<void>((r) => (outcomeSent = r));
    const onRecording = async (localPath: string) => {
      await outcomeShown;
      const fresh = (await store.getComplaint(approved.id).catch(() => null)) ?? approved;
      const ref = fresh.officialRequestNumber ?? fresh.activeAttemptId ?? approved.id;
      await tracer.withSession({ sessionId: ctx.chatId, metadata: { complaintId: approved.id } }, () =>
        tracer.span("telegram.send_recording", { "complaint.id": approved.id }, async () => {
          await ctx.t.send({ chatId: ctx.chatId, text: M.recording(ref), videoPath: localPath, parseMode: "HTML" });
        }),
      );
    };
    try {
      const resident = (await store.getOrCreateResident(ctx.chatId, ctx.resident.telegramUsername)) ?? ctx.resident;
      const onQuestion = (q: WorkerQuestion & { attemptId: string; timeoutMs: number }) => askResidentLive(ctx, approved, q);
      outcome = await filing.executeFiling(approved, { resident, onProgress, onRecording, onQuestion });
    } catch (err) {
      console.error("[orchestrator] executeFiling threw:", err);
      outcome = { complaintId: approved.id, attemptId: approved.activeAttemptId ?? "unknown", status: "FAILED", errorCode: "WORKER_CRASH", message: "the filing worker crashed" };
    } finally {
      pendingQuestions.get(approved.id)?.resolve(null);
    }
    await chain;
    await tracer.withSession({ sessionId: ctx.chatId, metadata: { complaintId: approved.id } }, () =>
      tracer.span("telegram.filing_outcome", { "complaint.id": approved.id, "filing.status": outcome.status, "filing.error_code": outcome.errorCode ?? "" }, async () => {
        await renderOutcome(ctx, approved, outcome);
      }),
    ).finally(() => outcomeSent());
  }

  /**
   * Live follow-up question from the filing worker: one Telegram message with the official options as buttons
   * (`answer_q:<id>:<v>:<qid>:<i>`) or a typed answer. Resolves on the answer (handle() fast path) or null on timeout.
   */
  function askResidentLive(ctx: Ctx, approved: ComplaintDraft, q: WorkerQuestion & { attemptId: string; timeoutMs: number }): Promise<WorkerAnswer | null> {
    pendingQuestions.get(approved.id)?.resolve(null);
    return new Promise<WorkerAnswer | null>((resolveAnswer) => {
      let timer: NodeJS.Timeout | undefined;
      const entry: PendingQuestion = {
        chatId: ctx.chatId,
        complaintId: approved.id,
        version: approved.draftVersion,
        attemptId: q.attemptId,
        question: { id: q.id, field: q.field, prompt: q.prompt, required: q.required, ...(q.options ? { options: q.options } : {}) },
        resolve: (a) => {
          clearTimeout(timer);
          if (pendingQuestions.get(approved.id) === entry) pendingQuestions.delete(approved.id);
          resolveAnswer(a);
        },
      };
      timer = setTimeout(() => entry.resolve(null), q.timeoutMs);
      pendingQuestions.set(approved.id, entry);
      const opts = q.options ?? [];
      const mins = Math.max(1, Math.round(q.timeoutMs / 60_000));
      const where = isRealOnly(approved.category) ? "The MTA form" : "The form";
      const text = [
        `⏸ <b>${where} needs one answer from you</b>`,
        esc(q.prompt),
        opts.length ? "Tap one below, or type your answer." : "Type your answer here.",
        `<i>Waiting for your answer — the browser is holding the page (up to ${mins} min).</i>`,
      ].join("\n\n");
      const buttons = opts.map((o, i) => [{ text: o.slice(0, 64), data: `${encodeCallback("answer_q", approved.id, approved.draftVersion)}:${q.id}:${i}` }]);
      void tracer
        .withSession({ sessionId: ctx.chatId, metadata: { complaintId: approved.id } }, () =>
          tracer.span("telegram.ask_question", { "complaint.id": approved.id, "question.id": q.id, "question.field": q.field }, async () => {
            await ctx.t.send({ chatId: ctx.chatId, text, parseMode: "HTML", ...(buttons.length ? { buttons } : {}) });
          }),
        )
        .catch((err) => console.warn("[orchestrator] could not send the worker question:", (err as Error).message));
    });
  }

  /**
   * Fast path (outside the per-chat queue, which may be awaiting the filing job): an `answer_q` tap or any typed
   * text while a worker question is pending answers it. Returns true when the event was consumed.
   */
  async function tryAnswerQuestion(event: InboundEvent, opts: HandleOptions): Promise<boolean> {
    let entry: PendingQuestion | undefined;
    let answer: WorkerAnswer;
    if (event.kind === "callback" && event.data.startsWith("answer_q:")) {
      const [, cid, v, qid, idx] = event.data.split(":");
      entry = cid ? pendingQuestions.get(cid) : undefined;
      if (!entry || entry.chatId !== event.chatId || entry.question.id !== qid || entry.version !== Number(v)) return false;
      const i = Number(idx);
      const label = Number.isInteger(i) ? entry.question.options?.[i] : undefined;
      if (label === undefined) return false;
      answer = { value: label, optionIndex: i };
    } else if (event.kind === "text" && event.text.trim()) {
      entry = [...pendingQuestions.values()].find((p) => p.chatId === event.chatId);
      if (!entry) return false;
      const typed = event.text.trim().slice(0, 500);
      const i = (entry.question.options ?? []).findIndex((o) => o.toLowerCase() === typed.toLowerCase());
      answer = i >= 0 ? { value: entry.question.options![i]!, optionIndex: i } : { value: typed };
    } else return false;
    if (!(await store.markUpdateProcessed(event.updateId))) return true;
    const e = entry;
    const t = opts.transport ?? deps.transport;
    await tracer.withSession({ sessionId: event.chatId, metadata: { complaintId: e.complaintId } }, () =>
      tracer.span("user.answer_question", { "complaint.id": e.complaintId, "attempt.id": e.attemptId, "question.id": e.question.id, "question.field": e.question.field, "answer.kind": answer.optionIndex !== undefined ? "option" : "text" }, async () => {
        e.resolve(answer);
        const ack = answer.optionIndex !== undefined ? `Got it: <b>${esc(answer.value)}</b>. Continuing in the same browser…` : "Got it. Continuing in the same browser…";
        await t.send({ chatId: event.chatId, text: ack, parseMode: "HTML" }).catch(() => {});
      }),
    );
    return true;
  }

  /** Bring the persisted complaint to the outcome state, tolerating a FilingService that already transitioned it. */
  async function settle(complaintId: string, fallback: ComplaintDraft, o: FilingOutcome): Promise<ComplaintDraft> {
    let d = (await store.getComplaint(complaintId)) ?? fallback;
    if (d.status === "APPROVED") d = await transition(store, d, "FILING", { reason: "filing started", actor: "system" });
    if (d.status === "FILING") d = await transition(store, d, o.status, { reason: o.errorCode ?? o.status.toLowerCase(), actor: "system" });
    if (o.attemptId && o.attemptId !== "none" && d.activeAttemptId !== o.attemptId) d = await store.saveComplaint({ ...d, activeAttemptId: o.attemptId });
    return d;
  }

  async function renderOutcome(ctx: Ctx, approved: ComplaintDraft, o: FilingOutcome) {
    let d: ComplaintDraft;
    try {
      d = await settle(approved.id, approved, o);
    } catch (err) {
      console.error("[orchestrator] could not settle outcome state:", (err as Error).message);
      d = (await store.getComplaint(approved.id)) ?? approved;
    }
    switch (o.status) {
      case "SUBMITTED": {
        if (!o.officialRequestNumber) {
          // Defensive: SUBMITTED without a parsed number is not a confirmation.
          await send(ctx, { text: M.unknown({ ...o, message: "No service request number was returned." }), buttons: linkButton("Check NYC311", NYC311_CHECK_STATUS_URL) });
          return;
        }
        d = await store.saveComplaint({ ...d, officialRequestNumber: o.officialRequestNumber });
        const req: OfficialRequest = {
          id: shortId("sr"),
          complaintId: d.id,
          officialRequestNumber: o.officialRequestNumber,
          officialCategory: getCategory(d.category)?.officialLabel ?? "Unknown",
          status: "Submitted",
          statusSource: "confirmation",
          lastCheckedAt: nowIso(),
          receiptUrl: o.officialReceiptUrl ?? null,
        };
        const known = (await store.listOfficialRequests(ctx.chatId).catch(() => [])).some((r) => r.officialRequestNumber === req.officialRequestNumber);
        if (!known) await store.saveOfficialRequest(req).catch((e) => console.warn("[orchestrator] saveOfficialRequest:", e.message));
        if (d.status === "SUBMITTED") d = await transition(store, d, "TRACKING", { reason: "tracking official request", actor: "system" });
        tracer.evaluate("filing_outcome", { label: "submitted", score: 1 });
        if (!isOpenDataBacked(d.category)) {
          // MTA: no public status page; "View official request" shows the captured confirmation screenshot.
          await send(ctx, { text: M.mtaSubmitted(o.officialRequestNumber), buttons: trackingButtons(d, o.officialReceiptUrl ?? null) });
          return;
        }
        await send(ctx, { text: o.message ? esc(o.message) : M.submitted(o), buttons: trackingButtons(d, o.officialReceiptUrl ?? NYC311_CHECK_STATUS_URL) });
        return;
      }
      case "HUMAN_ACTION_REQUIRED": {
        tracer.evaluate("filing_outcome", { label: "human_action_required", score: 0.5, explanation: o.errorCode });
        const url = finishUrl(d, o);
        const live = /https:\/\/\S+/.exec(o.message ?? "")?.[0]?.replace(/[).,]+$/, "") ?? null;
        const liveOk = isButtonSafeUrl(live);
        if (isRealOnly(d.category)) {
          const dryRun = !o.errorCode;
          const shot = await confirmationScreenshot(d);
          const text = dryRun ? M.mtaDryRun(liveOk ? live : null) : o.message ? `${esc(o.message)}\n\n${esc(url)}` : M.humanAction(o, url);
          await send(ctx, {
            text,
            ...(shot ? { photoPath: shot } : {}),
            buttons: [...linkButton("Open MTA Customer Feedback", url), ...(liveOk ? linkButton("🖥️ Open the same browser", live!) : []), [{ text: "❌ Cancel", data: `cancel:${d.id}:${d.draftVersion}` }]],
          });
          return;
        }
        await send(ctx, {
          text: o.message ? `${esc(o.message)}\n\n${esc(url)}` : M.humanAction(o, url),
          buttons: [...linkButton("Finish on NYC311", url), ...(liveOk ? linkButton("🖥️ Take over the browser", live!) : []), [{ text: "❌ Cancel", data: `cancel:${d.id}:${d.draftVersion}` }]],
        });
        return;
      }
      case "SUBMISSION_UNKNOWN": {
        tracer.evaluate("filing_outcome", { label: "submission_unknown", score: 0, explanation: o.errorCode });
        const mta = !isOpenDataBacked(d.category);
        await send(ctx, {
          text: o.message ? esc(o.message) : M.unknown(o),
          buttons: mta ? linkButton("Open MTA Customer Feedback", getCategory(d.category)?.officialFormUrl ?? NYC311_REPORT_URL) : linkButton("Check NYC311", NYC311_CHECK_STATUS_URL),
        });
        return;
      }
      case "FAILED": {
        tracer.evaluate("filing_outcome", { label: "failed", score: 0, explanation: o.errorCode });
        await send(ctx, { text: o.message ? `${esc(o.message)} You can try again from the draft.` : M.failed(o) });
        // "Try again from the draft": back to review with a new version so a fresh approval is required.
        try {
          if (d.status === "FAILED") {
            const bumped = { ...d, draftVersion: d.draftVersion + 1, approvedVersion: null, approvedAt: null };
            d = await transition(store, bumped, "READY_FOR_APPROVAL", { reason: "retry after failure", actor: "system" });
            await presentDraft(ctx, d);
          }
        } catch (err) {
          console.warn("[orchestrator] could not reopen draft:", (err as Error).message);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------------ entry
  async function processEvent(event: InboundEvent, opts: HandleOptions) {
    const t = opts.transport ?? deps.transport;
    const fresh = await store.markUpdateProcessed(event.updateId);
    if (!fresh) return;
    // Untraced lookup only to put the complaint id in session metadata; all traced reads happen inside the session.
    const active = await store.getActiveComplaint(event.chatId).catch(() => null);
    await tracer.withSession({ sessionId: event.chatId, metadata: { complaintId: active?.id ?? null } }, () =>
      tracer.span("telegram.message", { "event.kind": event.kind, "complaint.id": active?.id ?? "", "complaint.status": active?.status ?? "" }, async (_set, oi) => {
        oi.input(redactEvent(event));
        try {
          const resident = await tracer.span("surrealdb.read_context", { "query.kind": "resident" }, async () => store.getOrCreateResident(event.chatId, event.username));
          const ctx: Ctx = { chatId: event.chatId, t, resident, opts };
          switch (event.kind) {
            case "command":
              return await onCommand(ctx, event.command, event.args);
            case "text":
              return await onText(ctx, event.text);
            case "photo":
              return await onPhoto(ctx, event);
            case "voice":
              return await onVoice(ctx, event);
            case "location":
              return await onLocation(ctx, event);
            case "callback":
              return await onCallback(ctx, event);
          }
        } catch (err) {
          console.error(`[orchestrator] error handling ${event.kind}:`, err);
          await t.send({ chatId: event.chatId, text: M.error() }).catch(() => {});
        }
      }),
    );
  }

  async function handle(event: InboundEvent, opts: HandleOptions = {}): Promise<void> {
    if (pendingQuestions.size && (await tryAnswerQuestion(event, opts).catch((err) => (console.warn("[orchestrator] answer failed:", (err as Error).message), false)))) return;
    const prev = chains.get(event.chatId) ?? Promise.resolve();
    const run = prev.then(() => processEvent(event, opts)).catch(async (err) => {
      console.error("[orchestrator] unhandled:", err);
      const t = opts.transport ?? deps.transport;
      await t.send({ chatId: event.chatId, text: M.error() }).catch(() => {});
    });
    chains.set(event.chatId, run);
    await run;
    if (chains.get(event.chatId) === run) chains.delete(event.chatId);
  }

  /** Resolves when all background filing jobs are done (scripts/tests). */
  async function idle() {
    while (filingJobs.size) await Promise.allSettled([...filingJobs.values()]);
  }

  /** Live worker questions currently waiting for an answer (API/scripts/evals). */
  function pendingQuestionsFor(chatId: string) {
    return [...pendingQuestions.values()].filter((p) => p.chatId === chatId).map((p) => ({ complaintId: p.complaintId, version: p.version, attemptId: p.attemptId, question: p.question }));
  }

  return { handle, idle, complaints, pendingQuestions: pendingQuestionsFor };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;

function normalizeStatus(r: unknown): { found: boolean; status: string | null; detail?: string | null; source?: string | null } {
  if (!r || typeof r !== "object") return { found: false, status: null };
  const o = r as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status : null;
  const found = typeof o.found === "boolean" ? o.found : status != null;
  const detail = [o.detail, o.resolutionDescription, o.message, o.category].find((x) => typeof x === "string") as string | undefined;
  const source = typeof o.source === "string" ? o.source : null;
  return { found, status, detail: detail ?? null, source };
}

/** Never put file ids/paths or tokens into traces. */
function redactEvent(e: InboundEvent): Record<string, unknown> {
  switch (e.kind) {
    case "photo":
      return { kind: e.kind, caption: e.caption };
    case "voice":
      return { kind: e.kind, durationSec: e.durationSec };
    case "location":
      return { kind: e.kind, lat: Number(e.latitude.toFixed(3)), lon: Number(e.longitude.toFixed(3)) };
    case "callback":
      return { kind: e.kind, action: e.data.split(":")[0] };
    case "command":
      return { kind: e.kind, command: e.command };
    case "text":
      return { kind: e.kind, text: e.text };
  }
}
