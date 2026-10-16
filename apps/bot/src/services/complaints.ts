/**
 * ComplaintService: drafts, classification application, approval and
 * persistence. All status changes go through core/state-machine.ts.
 */
import type { ClassificationResult, ComplaintDraft, ComplaintLocation, ComplaintState, Store, TransitDetails } from "../core/contracts.js";
import { CLASSIFY_CONFIDENCE_THRESHOLD, EMPTY_LOCATION, nowIso, shortId } from "../core/contracts.js";
import { canonicalSubwayLine, getCategory, isRealOnly, isSupportedCategory, materialChanges, mergeTransit, missingFields, requiredFieldsFor } from "../core/knowledge.js";
import { type Actor, VersionMismatchError, bumpDraft, canTransition, transition } from "../core/state-machine.js";
import { esc } from "../telegram/messages.js";

/** What the orchestrator should do next after a classification. */
export type TriageDecision =
  | { kind: "EMERGENCY" }
  | { kind: "OUT_OF_SCOPE" }
  | { kind: "CLARIFY"; question: string | null }
  | { kind: "CONTINUE" };

/** States where new user input is merged into the draft. */
export const OPEN_STATES: ComplaintState[] = ["RECEIVED", "TRIAGING", "NEEDS_INFORMATION", "DUPLICATE_REVIEW", "READY_FOR_APPROVAL"];

export type ApprovalResult =
  | { ok: true; draft: ComplaintDraft }
  | { ok: false; reason: "VERSION_MISMATCH" | "NOT_READY" | "NOT_USER"; draft: ComplaintDraft };

export function createComplaintService(store: Store) {
  /** If a material field changed, bump version (invalidates approval) and reset duplicate review when needed. */
  function reconcile(before: ComplaintDraft, after: ComplaintDraft): ComplaintDraft {
    const changed = materialChanges(before, after);
    if (!changed.length) return after;
    let next = bumpDraft(after);
    if (changed.includes("location") || changed.includes("category")) {
      next = { ...next, duplicateReviewed: false, duplicates: [] };
    }
    return next;
  }

  const svc = {
    store,

    async newDraft(chatId: string, residentId: string): Promise<ComplaintDraft> {
      const now = nowIso();
      const draft: ComplaintDraft = {
        id: shortId("cmp"),
        telegramChatId: chatId,
        residentId,
        status: "RECEIVED",
        category: null,
        triage: null,
        description: "",
        userMessages: [],
        location: { ...EMPTY_LOCATION },
        media: [],
        classification: null,
        transit: null,
        missingFields: ["category", "location", "description"],
        needsEmergencyReferral: false,
        confidence: 0,
        duplicates: [],
        duplicateReviewed: false,
        duplicatesDataAsOf: null,
        draftVersion: 1,
        approvedVersion: null,
        approvedAt: null,
        activeAttemptId: null,
        officialRequestNumber: null,
        statusReason: null,
        traceId: null,
        createdAt: now,
        updatedAt: now,
      };
      return store.createComplaint(draft);
    },

    computeMissing(draft: ComplaintDraft): ComplaintDraft {
      return { ...draft, missingFields: missingFields(draft) };
    },

    /**
     * Applies a (Zod-validated) classifier result. The backend re-validates the
     * category against the allowlist; low confidence ⇒ clarify.
     * Does not change status; returns the updated (unsaved) draft + decision.
     */
    applyClassification(draft: ComplaintDraft, result: ClassificationResult): { draft: ComplaintDraft; decision: TriageDecision } {
      let triage = result.triage;
      let category = result.category;
      if (triage === "SUPPORTED" && !isSupportedCategory(category)) {
        triage = "UNCLEAR";
        category = null;
      }
      const lowConfidence = triage === "SUPPORTED" && result.confidence < CLASSIFY_CONFIDENCE_THRESHOLD;
      const description = result.description?.trim() ? result.description.trim() : draft.description;
      const nextCategory = triage === "SUPPORTED" && !lowConfidence ? category : draft.category;
      // Transit details: only for categories that need them; merged across messages, a null never erases a known value.
      const transit = requiredFieldsFor(nextCategory).includes("transit") ? mergeTransit(draft.transit, sanitizeTransit(result.transit)) : (draft.transit ?? null);
      const after: ComplaintDraft = {
        ...draft,
        triage,
        classification: result,
        confidence: result.confidence,
        needsEmergencyReferral: triage === "EMERGENCY",
        // Keep a previously known category when the new answer is unclear (conversation memory).
        category: nextCategory,
        description: triage === "SUPPORTED" || triage === "UNCLEAR" ? description : draft.description,
        transit,
        updatedAt: nowIso(),
      };
      const next = svc.computeMissing(reconcile(draft, after));
      let decision: TriageDecision;
      if (triage === "EMERGENCY") decision = { kind: "EMERGENCY" };
      else if (triage === "OUT_OF_SCOPE") decision = { kind: "OUT_OF_SCOPE" };
      else if (triage === "UNCLEAR" || lowConfidence) {
        decision = next.category && !lowConfidence ? { kind: "CONTINUE" } : { kind: "CLARIFY", question: result.clarifyingQuestion };
      } else decision = { kind: "CONTINUE" };
      return { draft: next, decision };
    },

    setLocation(draft: ComplaintDraft, loc: ComplaintLocation): ComplaintDraft {
      const after = { ...draft, location: loc, updatedAt: nowIso() };
      return svc.computeMissing(reconcile(draft, after));
    },

    /** Merge user-provided transit details (deterministic answers to the line/direction questions). */
    setTransit(draft: ComplaintDraft, patch: Partial<TransitDetails>): ComplaintDraft {
      const merged = mergeTransit(draft.transit, { line: null, direction: null, station: null, borough: null, incidentTime: null, delayMinutes: null, ...patch });
      return svc.computeMissing(reconcile(draft, { ...draft, transit: merged, updatedAt: nowIso() }));
    },

    setDescription(draft: ComplaintDraft, description: string): ComplaintDraft {
      return svc.computeMissing(reconcile(draft, { ...draft, description, updatedAt: nowIso() }));
    },

    /** Moves the draft into TRIAGING from any open state, via allowed paths. */
    async enterTriage(draft: ComplaintDraft, reason: string, actor: Actor = "system"): Promise<ComplaintDraft> {
      if (draft.status === "TRIAGING") return store.saveComplaint(draft);
      if (draft.status === "DUPLICATE_REVIEW") draft = await transition(store, draft, "NEEDS_INFORMATION", { reason, actor });
      return transition(store, draft, "TRIAGING", { reason, actor });
    },

    /** Transition unless already there (self-loops only where TRANSITIONS allows). */
    async moveTo(draft: ComplaintDraft, to: ComplaintState, reason: string, actor: Actor = "system"): Promise<ComplaintDraft> {
      if (draft.status === to && !canTransition(to, to)) return store.saveComplaint({ ...draft, statusReason: reason });
      return transition(store, draft, to, { reason, actor });
    },

    buildSummary(draft: ComplaintDraft, opts: { contactName?: string | null; contactEmail?: string | null; target?: "demo" | "real"; alertLine?: string | null } = {}): string {
      const cat = getCategory(draft.category);
      if (requiredFieldsFor(draft.category).includes("transit")) return buildTransitSummary(draft, opts);
      const loc = draft.location;
      const where =
        loc.address ??
        (loc.latitude != null && loc.longitude != null ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}` : "Not provided yet");
      const locLine = `${esc(where)}${loc.borough && !(loc.address ?? "").includes(loc.borough) ? `, ${esc(loc.borough)}` : ""}${
        loc.userConfirmed ? (loc.source === "pin" ? " <i>(your pin)</i>" : " <i>(you typed it)</i>") : ""
      }`;
      const photos = draft.media.filter((m) => m.type === "photo").length;
      const evidence = photos === 0 ? "No photo" : photos === 1 ? "One uploaded photograph" : `${photos} uploaded photographs`;
      const lines = [
        "Here's your report. Please check it before I file:",
        "",
        `<b>Problem:</b> ${esc(cat?.label ?? "Unknown")}`,
        `<b>Location:</b> ${locLine}`,
        `<b>Description:</b> ${esc(draft.description || "-")}`,
        `<b>Category:</b> ${esc(cat?.officialLabel ?? "-")}`,
        `<b>Evidence:</b> ${evidence}`,
      ];
      if (opts.contactName) lines.push(`<b>Contact name:</b> ${esc(opts.contactName)}`);
      if (draft.duplicates.length && draft.duplicateReviewed) lines.push(`<i>You chose to continue despite ${draft.duplicates.length} similar nearby report(s).</i>`);
      lines.push("", opts.target === "real" ? "Filing target: <b>official NYC DOT form</b>" : "Filing target: <b>NYC311 Demo Portal</b> (safe replica, not the official site)");
      lines.push("", `<i>Draft v${draft.draftVersion}. Nothing is filed until you tap Approve.</i>`);
      return lines.join("\n");
    },

    /** User approval bound to an exact draft version. Only a user can approve. */
    async approve(draft: ComplaintDraft, version: number, actor: Actor): Promise<ApprovalResult> {
      if (actor !== "user") return { ok: false, reason: "NOT_USER", draft };
      if (draft.status !== "READY_FOR_APPROVAL") return { ok: false, reason: "NOT_READY", draft };
      if (version !== draft.draftVersion) return { ok: false, reason: "VERSION_MISMATCH", draft };
      const stamped = { ...draft, approvedVersion: version, approvedAt: nowIso() };
      try {
        const approved = await transition(store, stamped, "APPROVED", { reason: `user approved v${version}`, actor });
        return { ok: true, draft: approved };
      } catch (err) {
        if (err instanceof VersionMismatchError) return { ok: false, reason: "VERSION_MISMATCH", draft };
        throw err;
      }
    },

    async cancel(draft: ComplaintDraft, actor: Actor = "user"): Promise<ComplaintDraft> {
      if (draft.status === "CANCELLED") return draft;
      return transition(store, draft, "CANCELLED", { reason: "cancelled by user", actor });
    },

    /** "Edit details": back to NEEDS_INFORMATION with a new version (prior approval void). */
    async editRequest(draft: ComplaintDraft): Promise<ComplaintDraft> {
      const bumped = bumpDraft(draft);
      if (bumped.status === "DUPLICATE_REVIEW" || bumped.status === "READY_FOR_APPROVAL" || bumped.status === "NEEDS_INFORMATION" || canTransition(bumped.status, "NEEDS_INFORMATION")) {
        return transition(store, bumped, "NEEDS_INFORMATION", { reason: "user requested edit", actor: "user" });
      }
      if (canTransition(bumped.status, "READY_FOR_APPROVAL")) {
        // e.g. FAILED / HUMAN_ACTION_REQUIRED → back to review
        const ready = await transition(store, bumped, "READY_FOR_APPROVAL", { reason: "user requested edit", actor: "user" });
        return transition(store, ready, "NEEDS_INFORMATION", { reason: "user requested edit", actor: "user" });
      }
      return store.saveComplaint(bumped);
    },
  };
  return svc;
}

export type ComplaintService = ReturnType<typeof createComplaintService>;

/** Canonicalize LLM-extracted transit details; anything unrecognised becomes null (never invented). */
export function sanitizeTransit(t: TransitDetails | null | undefined): TransitDetails | null {
  if (!t) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
  const iso = str(t.incidentTime);
  const minutes = typeof t.delayMinutes === "number" && Number.isFinite(t.delayMinutes) && t.delayMinutes > 0 && t.delayMinutes < 600 ? Math.round(t.delayMinutes) : null;
  return {
    line: canonicalSubwayLine(t.line),
    direction: str(t.direction),
    station: str(t.station),
    borough: str(t.borough),
    incidentTime: iso && Number.isFinite(new Date(iso).getTime()) ? iso : null,
    delayMinutes: minutes,
  };
}

/** "8:30 AM, Oct 16" in New York time. */
export function fmtIncidentTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  return `${time}, ${day}`;
}

export function lineLabel(line: string | null | undefined): string {
  if (!line) return "the subway";
  return /^[0-9A-Z]$/.test(line) ? `${line} train` : line;
}

function buildTransitSummary(draft: ComplaintDraft, opts: { contactName?: string | null; contactEmail?: string | null; alertLine?: string | null }): string {
  const cat = getCategory(draft.category);
  const t = draft.transit;
  const lineDir = [t?.line ? lineLabel(t.line) : "Line not given", t?.direction ? t.direction : "direction not given"].join(", ");
  const station = t?.station ? `${esc(t.station)}${t.borough ? `, ${esc(t.borough)}` : ""}` : "Not given";
  const when = [fmtIncidentTime(t?.incidentTime) ?? "Time not given", t?.delayMinutes ? `about ${t.delayMinutes} min delay` : null].filter(Boolean).join(" · ");
  const lines = [
    "Here's your MTA complaint. Please check it before I file:",
    "",
    `<b>Problem:</b> ${esc(cat?.label ?? "Subway delay")}`,
    `<b>Line &amp; direction:</b> ${esc(lineDir)}`,
    `<b>Station:</b> ${station}`,
    `<b>When:</b> ${esc(when)}`,
    `<b>Description:</b> ${esc(draft.description || "-")}`,
    `<b>Where it's filed:</b> ${esc(cat?.officialLabel ?? "MTA Customer Feedback")}`,
  ];
  if (opts.contactName) lines.push(`<b>Contact name:</b> ${esc(opts.contactName)}`);
  if (opts.contactEmail) lines.push(`<b>Contact email:</b> ${esc(opts.contactEmail)}`);
  if (!opts.contactName && !opts.contactEmail) lines.push("<i>No contact details will be sent (optional: /name, /email if you want the MTA to reply).</i>");
  if (opts.alertLine) lines.push("", opts.alertLine);
  if (isRealOnly(draft.category)) lines.push("", "⚠️ <b>This files a real complaint with the MTA. Only approve if this actually happened to you.</b>");
  lines.push("", `<i>Draft v${draft.draftVersion}. Nothing is filed until you tap Approve.</i>`);
  return lines.join("\n");
}
