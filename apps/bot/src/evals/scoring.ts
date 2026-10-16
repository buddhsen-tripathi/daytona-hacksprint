/**
 * Deterministic, category-aware scorer for scripts/evals.ts (design doc §13.2).
 *
 * Pure: takes a scenario (fixtures/example-complaints.json), the transcript the eval runner recorded
 * and the final complaint + filing attempts from the bot API, and returns one Score per dimension
 * (null = not applicable). No I/O, so it is unit-tested with canned transcripts (scoring.test.ts).
 *
 * Location-based categories (kept for future street categories + the triage outcomes):
 *   category_accuracy, information_completeness, location_validity, submission_safety, outcome_accuracy, duplicate_relevance
 * Transit categories (requiredFields includes "transit", e.g. subway-delay → MTA):
 *   category_accuracy, information_completeness, transit_extraction, submission_safety, outcome_accuracy, alert_corroboration
 */
import { CATEGORIES, NYC_BOUNDS } from "../core/contracts.js";
import type { CategoryId, ComplaintDraft, FilingAttempt, OutboundMessage } from "../core/contracts.js";

// ---------------------------------------------------------------------------
// Scenario + transcript shapes
// ---------------------------------------------------------------------------
/** A transit follow-up the bot can ask before the approval card. */
export type TransitAsk = "line" | "direction" | "time";
/** Every question kind the runner can observe. `learned:<field>` = workflow-memory question (always allowed). */
export type Ask = TransitAsk | "location" | "clarify" | "other" | `learned:${string}`;

export type ExpectedTransit = {
  /** Canonical line (exact, case-insensitive). */
  line?: string;
  /** Substring (lowercase) of the direction in the rider's words; also what classify-check.ts checks on the raw classifier output. */
  directionIncludes?: string;
  /** Substring (lowercase) of the draft's final direction when it differs from the rider's words (the MTA option the resident tapped). Defaults to directionIncludes. */
  directionResolvedIncludes?: string;
  stationIncludes?: string;
  delayMinutes?: number;
  /** "HH:mm" New York local time of transit.incidentTime. */
  timeLocal?: string;
};

export type EvalScenario = {
  id: string;
  scenario: string;
  expectedBehavior: string;
  inputText: string | null;
  imageFixture: string | null;
  location: { latitude: number; longitude: number; address?: string; borough?: string } | null;
  flow?: { afterDraft?: "approve" | "cancel"; expect?: "captcha-handoff" };
  /** How the fake resident answers transit follow-ups (defaults derive from expected.transit). */
  followUps?: { line?: string; direction?: string };
  skipEvals?: boolean;
  expected: {
    triage: string;
    acceptTriage?: string[];
    category: string | null;
    asksForLocation?: boolean;
    emergency: boolean;
    expectDuplicates?: boolean;
    transit?: ExpectedTransit;
    /** Transit follow-ups the bot MUST ask (the text leaves them missing / ambiguous). */
    asks?: TransitAsk[];
    /** Transit follow-ups the bot MAY ask (e.g. "this morning" is not a time). Anything else is an unnecessary question. */
    mayAsk?: TransitAsk[];
  };
};

export type EvalMsg = OutboundMessage & { messageId?: number };

export type Transcript = {
  all: EvalMsg[];
  approvedTapped: boolean;
  cancelled: boolean;
  draftOffered: boolean;
  dupOffered: boolean;
  locationAskedBeforeDraft: boolean;
  /** Questions asked before the approval card, in order (transit runner). */
  asks: Ask[];
  /** The approval card (the message carrying the approve button), if one was shown. */
  card: EvalMsg | null;
  /** The runner performed the one real Daytona + Anchor dry run for this scenario (--with-dry-run). */
  dryRun: boolean;
};

export const emptyTranscript = (): Transcript => ({ all: [], approvedTapped: false, cancelled: false, draftOffered: false, dupOffered: false, locationAskedBeforeDraft: false, asks: [], card: null, dryRun: false });

export type Score = { label: string; score: number; explanation: string } | null;
export type ScoreOptions = { skipFiling?: boolean };

/** Union of both dimension sets, in table order. */
export const DIMENSIONS = ["category_accuracy", "information_completeness", "location_validity", "transit_extraction", "submission_safety", "outcome_accuracy", "duplicate_relevance", "alert_corroboration"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const LOCATION_DIMENSIONS: Dimension[] = ["category_accuracy", "information_completeness", "location_validity", "submission_safety", "outcome_accuracy", "duplicate_relevance"];
export const TRANSIT_DIMENSIONS: Dimension[] = ["category_accuracy", "information_completeness", "transit_extraction", "submission_safety", "outcome_accuracy", "alert_corroboration"];

const ok = (cond: boolean, yes: string, no: string, explanation: string): Score => ({ label: cond ? yes : no, score: cond ? 1 : 0, explanation });

// ---------------------------------------------------------------------------
// Helpers the runner shares with the scorer
// ---------------------------------------------------------------------------
/** Transit scenario = the expected category requires transit details (category registry, not a hard-coded id). */
export function isTransitScenario(s: EvalScenario): boolean {
  const def = s.expected.category ? CATEGORIES[s.expected.category as CategoryId] : undefined;
  return !!def?.requiredFields.includes("transit");
}

export const hasButton = (m: EvalMsg, action: string) => (m.buttons ?? []).some((row) => row.some((b) => b.data?.startsWith(`${action}:`)));

export const asksLocation = (m: EvalMsg) => !!m.requestLocation || /\b(location|address|where (is|exactly)|cross ?street|📍)/i.test(m.text);

/**
 * What did the bot just ask? Prefers the draft's statusReason (deterministic, set by the orchestrator when it
 * moves to NEEDS_INFORMATION); falls back to the message text / buttons.
 */
export function classifyAsk(msg: EvalMsg | undefined, statusReason?: string | null): Ask | null {
  const r = statusReason ?? "";
  if (r.startsWith("missing: learned:")) return `learned:${r.slice("missing: learned:".length)}`;
  if (r === "missing: transit line") return "line";
  if (r === "missing: direction" || r === "missing: transit direction") return "direction";
  if (r === "missing: time") return "time";
  if (r === "missing: location") return "location";
  if (/^missing: (category|description)|classifier unavailable/.test(r)) return "clarify";
  if (!msg) return null;
  if (hasButton(msg, "set_direction") || /which (way|direction)/i.test(msg.text)) return "direction";
  if (hasButton(msg, "set_time") || /when did this happen|what time was it/i.test(msg.text)) return "time";
  if (/which line/i.test(msg.text)) return "line";
  if (msg.requestLocation || /share the location|nearest intersection/i.test(msg.text)) return "location";
  return msg.text.includes("?") ? "other" : null;
}

/** "HH:mm" in New York for an ISO datetime. */
export function nyLocalTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

const FILED_STATES = ["APPROVED", "FILING", "SUBMITTED", "TRACKING", "HUMAN_ACTION_REQUIRED", "SUBMISSION_UNKNOWN", "FAILED"];

/** A scenario passes when every applicable dimension scores 1. */
export const passed = (scores: Record<string, Score>) => Object.values(scores).every((v) => v == null || v.score >= 1);

// ---------------------------------------------------------------------------
// Shared dimensions
// ---------------------------------------------------------------------------
/** No filing attempt unless the resident tapped Approve on the current draft version; never after a cancel. */
function submissionSafety(t: Transcript, c: ComplaintDraft | null, attempts: FilingAttempt[]): Score {
  const status = c?.status ?? "NONE";
  const filed = attempts.length > 0 || FILED_STATES.includes(status);
  const versionOk = !filed || (c?.approvedVersion != null && attempts.every((a) => a.approvedVersion === c.approvedVersion));
  const atMostOnce = attempts.length <= 1;
  return ok(
    (!filed || t.approvedTapped) && versionOk && atMostOnce && !(t.cancelled && filed),
    "safe",
    "unsafe",
    filed ? `filed after approve tap=${t.approvedTapped}, approvedVersion=${c?.approvedVersion ?? "none"}, attempts=${attempts.length}` : `no filing attempted${t.cancelled ? " (cancelled)" : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Transit categories (subway-delay → MTA Customer Feedback)
// ---------------------------------------------------------------------------
function scoreTransit(s: EvalScenario, t: Transcript, c: ComplaintDraft | null, attempts: FilingAttempt[]): Record<string, Score> {
  const status = c?.status ?? "NONE";
  const texts = t.all.map((m) => m.text).join("\n");
  const out: Record<string, Score> = {};

  out.category_accuracy = ok(c?.category === s.expected.category && c?.triage === "SUPPORTED", "correct", "incorrect", `expected SUPPORTED/${s.expected.category}, got ${c?.triage ?? "none"}/${c?.category ?? "none"}`);

  // Information completeness: ask line/direction/time only when the text leaves them missing; never ask for a location.
  {
    const must = new Set<Ask>(s.expected.asks ?? []);
    const may = new Set<Ask>([...must, ...(s.expected.mayAsk ?? [])]);
    const asked = t.asks.filter((a) => !a.startsWith("learned:"));
    const missed = [...must].filter((a) => !asked.includes(a));
    const extra = asked.filter((a) => !may.has(a));
    const repeated = asked.filter((a, i) => asked.indexOf(a) !== i);
    const good = t.draftOffered && !missed.length && !extra.length && !repeated.length;
    const why = [
      `asked [${asked.join(",") || "none"}]`,
      `expected [${[...must].join(",") || "none"}]${s.expected.mayAsk?.length ? ` (may: ${s.expected.mayAsk.join(",")})` : ""}`,
      missed.length ? `missed ${missed.join(",")}` : null,
      extra.length ? `unnecessary ${extra.join(",")}` : null,
      repeated.length ? `repeated ${[...new Set(repeated)].join(",")}` : null,
      t.draftOffered ? null : "no approval card",
    ].filter(Boolean);
    out.information_completeness = ok(good, "complete", "incomplete", why.join("; "));
  }

  // Transit extraction: line / direction / station / delay / time match the fixture.
  {
    const e = s.expected.transit ?? {};
    const tr = c?.transit ?? null;
    const has = (v: string | null | undefined, sub: string) => !!v && v.toLowerCase().includes(sub.toLowerCase());
    const checks: [string, boolean, string][] = [];
    if (e.line != null) checks.push(["line", (tr?.line ?? "").toLowerCase() === e.line.toLowerCase(), `${tr?.line ?? "null"}`]);
    const dir = e.directionResolvedIncludes ?? e.directionIncludes;
    if (dir != null) checks.push(["direction", has(tr?.direction, dir), `${tr?.direction ?? "null"}`]);
    if (e.stationIncludes != null) checks.push(["station", has(tr?.station, e.stationIncludes), `${tr?.station ?? "null"}`]);
    if (e.delayMinutes != null) checks.push(["delay", tr?.delayMinutes === e.delayMinutes, `${tr?.delayMinutes ?? "null"}`]);
    if (e.timeLocal != null) {
      const local = nyLocalTime(tr?.incidentTime);
      checks.push(["time", local === e.timeLocal || (tr?.incidentTime ?? "").includes(`T${e.timeLocal}`), `${local ?? "null"}`]);
    }
    if (!checks.length) out.transit_extraction = null;
    else {
      const hit = checks.filter(([, good]) => good).length;
      const frac = hit / checks.length;
      out.transit_extraction = {
        label: frac === 1 ? "match" : frac > 0 ? "partial" : "mismatch",
        score: Number(frac.toFixed(2)),
        explanation: checks.map(([k, good, got]) => `${k}${good ? "✓" : "✗"}=${got}`).join(", "),
      };
    }
  }

  out.submission_safety = submissionSafety(t, c, attempts);

  // Outcome accuracy: default stops at the card; cancel ⇒ CANCELLED; dry run ⇒ HUMAN_ACTION_REQUIRED, no error code.
  // In every case: never a reference number unless the confirmation page produced one (no SUBMITTED here).
  {
    const a = attempts[0];
    const noRef = !c?.officialRequestNumber && attempts.every((x) => !x.officialRequestNumber) && !/Reference:/i.test(texts);
    if (s.flow?.afterDraft === "cancel") {
      out.outcome_accuracy = ok(status === "CANCELLED" && attempts.length === 0 && noRef, "correct", "incorrect", `status ${status}, attempts ${attempts.length}`);
    } else if (t.dryRun) {
      const good = status === "HUMAN_ACTION_REQUIRED" && attempts.length === 1 && !a?.errorCode && a?.outcome === "HUMAN_ACTION_REQUIRED" && noRef && /dry run/i.test(texts);
      out.outcome_accuracy = ok(good, "correct", "incorrect", `dry run: status ${status}, attempts ${attempts.length}, outcome ${a?.outcome ?? "none"}, error ${a?.errorCode ?? "none"}, reference ${c?.officialRequestNumber ?? "none"}`);
    } else {
      out.outcome_accuracy = ok(status === "READY_FOR_APPROVAL" && attempts.length === 0 && noRef, "correct", "incorrect", `stopped at the card: status ${status}, attempts ${attempts.length}`);
    }
  }

  // Alert corroboration: the card carries the live MTA alert line or the "no active alert" line.
  {
    const card = t.card?.text ?? "";
    if (!t.card) out.alert_corroboration = { label: "missing", score: 0, explanation: "no approval card shown" };
    else if (/MTA currently reports:/i.test(card)) out.alert_corroboration = { label: "corroborated", score: 1, explanation: "live MTA delay alert on the card" };
    else if (/No active MTA delay alert/i.test(card)) out.alert_corroboration = { label: "no_active_alert", score: 1, explanation: "card says no active MTA delay alert" };
    else if (/couldn't reach the live MTA alerts feed/i.test(card)) out.alert_corroboration = { label: "feed_unavailable", score: 0.5, explanation: "MTA alerts feed unreachable (disclosed on the card)" };
    else out.alert_corroboration = { label: "missing", score: 0, explanation: "card has neither an MTA alert line nor a no-active-alert line" };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Location-based categories + triage outcomes (OUT_OF_SCOPE / EMERGENCY / UNCLEAR)
// ---------------------------------------------------------------------------
function scoreLocationFlow(s: EvalScenario, t: Transcript, c: ComplaintDraft | null, attempts: FilingAttempt[], opts: ScoreOptions): Record<string, Score> {
  const status = c?.status ?? "NONE";
  const texts = t.all.map((m) => m.text).join("\n");
  const out: Record<string, Score> = {};

  if (s.expected.triage === "SUPPORTED") {
    out.category_accuracy = ok(c?.category === s.expected.category, "correct", "incorrect", `expected ${s.expected.category}, got ${c?.category ?? "none"} (triage ${c?.triage ?? "none"})`);
  } else if (s.expected.triage === "EMERGENCY") {
    out.category_accuracy = ok(status === "EMERGENCY_REFERRAL" || c?.triage === "EMERGENCY", "correct", "incorrect", `expected EMERGENCY, got triage ${c?.triage ?? "none"} / ${status}`);
  } else if (s.expected.triage === "OUT_OF_SCOPE") {
    out.category_accuracy = ok(status === "OUT_OF_SCOPE" || c?.triage === "OUT_OF_SCOPE" || (!!c?.triage && (s.expected.acceptTriage ?? []).includes(c.triage) && !t.draftOffered), "correct", "incorrect", `expected OUT_OF_SCOPE, got triage ${c?.triage ?? "none"} / ${status}`);
  } else {
    // UNCLEAR: must not confidently pick a category and offer filing
    out.category_accuracy = ok(!t.draftOffered, "correct", "incorrect", `expected clarification, ${t.draftOffered ? "a draft was offered" : `got ${c?.triage ?? "no triage"} / ${status}`}`);
  }

  if (s.expected.emergency || s.expected.triage === "OUT_OF_SCOPE") out.information_completeness = null;
  else if (s.expected.triage === "UNCLEAR") {
    const asked = t.locationAskedBeforeDraft || t.all.some((m) => m.text.includes("?"));
    out.information_completeness = ok(asked && !t.draftOffered, "complete", "incomplete", asked ? "asked a clarifying question instead of guessing" : "no clarifying question asked");
  } else if (s.expected.asksForLocation) {
    out.information_completeness = ok(t.locationAskedBeforeDraft && !t.draftOffered, "complete", "incomplete", t.locationAskedBeforeDraft ? "asked for the missing location before any draft" : "never asked for the missing location");
  } else {
    const hasLoc = c?.location?.latitude != null || !!c?.location?.address;
    const good = t.draftOffered && hasLoc && !!c?.description && (c?.missingFields?.length ?? 0) === 0;
    out.information_completeness = ok(good, "complete", "incomplete", `draft offered=${t.draftOffered}, location=${hasLoc}, missing=${(c?.missingFields ?? []).join(",") || "none"}`);
  }

  if (s.expected.emergency || s.expected.triage === "OUT_OF_SCOPE") out.location_validity = null;
  else if (!s.location) {
    out.location_validity = ok(!t.draftOffered && !c?.location?.userConfirmed, "valid", "invalid", t.draftOffered ? "draft offered without a user-provided location" : "no location inferred; waited for the resident");
  } else {
    const l = c?.location;
    const inBox = l?.latitude != null && l.longitude != null && l.latitude >= NYC_BOUNDS.minLat && l.latitude <= NYC_BOUNDS.maxLat && l.longitude >= NYC_BOUNDS.minLon && l.longitude <= NYC_BOUNDS.maxLon;
    out.location_validity = ok(!!l?.userConfirmed && l.withinNyc !== false && inBox, "valid", "invalid", `userConfirmed=${l?.userConfirmed ?? false}, withinNyc=${l?.withinNyc ?? "?"}, source=${l?.source ?? "none"}`);
  }

  out.submission_safety = submissionSafety(t, c, attempts);

  const a = attempts[0];
  const expectHandoff = s.flow?.expect === "captcha-handoff";
  if (s.flow?.afterDraft === "cancel") {
    out.outcome_accuracy = ok(status === "CANCELLED" && attempts.length === 0, "correct", "incorrect", `status ${status}, attempts ${attempts.length}`);
  } else if (s.flow?.afterDraft === "approve" && !opts.skipFiling) {
    if (expectHandoff) out.outcome_accuracy = ok(status === "HUMAN_ACTION_REQUIRED" && a?.errorCode === "CAPTCHA" && !c?.officialRequestNumber, "correct", "incorrect", `status ${status}, error ${a?.errorCode ?? "none"}`);
    else out.outcome_accuracy = ok(["SUBMITTED", "TRACKING"].includes(status) && !!a?.verified && !!c?.officialRequestNumber, "correct", "incorrect", `status ${status}, verified ${a?.verified ?? false}, SR ${c?.officialRequestNumber ?? "none"}`);
  } else if (s.expected.emergency) {
    out.outcome_accuracy = ok(status === "EMERGENCY_REFERRAL" && /911/.test(texts) && !t.draftOffered, "correct", "incorrect", `status ${status}, 911 mentioned=${/911/.test(texts)}`);
  } else if (s.expected.triage === "OUT_OF_SCOPE") {
    out.outcome_accuracy = ok(!t.draftOffered && /311/.test(texts), "correct", "incorrect", `status ${status}, manual guidance=${/portal\.311|311/.test(texts)}`);
  } else if (s.expected.expectDuplicates) {
    out.outcome_accuracy = ok(t.dupOffered && attempts.length === 0, "correct", "incorrect", `existing report offered for review=${t.dupOffered}`);
  } else {
    out.outcome_accuracy = ok(attempts.length === 0 && !c?.officialRequestNumber, "correct", "incorrect", `no filing claimed (status ${status})`);
  }

  const dups = c?.duplicates ?? [];
  if (dups.length) {
    const relevant = dups.filter((d) => (d.distanceMeters ?? 1e9) <= 150 && /street condition/i.test(d.complaintType) && d.ageDays <= 90);
    const frac = relevant.length / dups.length;
    out.duplicate_relevance = { label: frac === 1 ? "relevant" : frac > 0 ? "partially_relevant" : "irrelevant", score: Number(frac.toFixed(2)), explanation: `${relevant.length}/${dups.length} within 150 m, Street Condition, ≤90 d; offered=${t.dupOffered}` };
  } else if (s.expected.expectDuplicates) {
    out.duplicate_relevance = { label: "missed", score: 0, explanation: "expected nearby Open Data requests; none surfaced (Open Data may be unavailable)" };
  } else out.duplicate_relevance = null;

  return out;
}

/** Score one scenario. Transit scenarios get the transit dimension set; everything else the location set. */
export function score(s: EvalScenario, t: Transcript, c: ComplaintDraft | null, attempts: FilingAttempt[], opts: ScoreOptions = {}): Record<string, Score> {
  return isTransitScenario(s) ? scoreTransit(s, t, c, attempts) : scoreLocationFlow(s, t, c, attempts, opts);
}
