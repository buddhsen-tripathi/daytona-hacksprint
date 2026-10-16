import { describe, expect, it } from "vitest";
import type { ClassificationResult, TransitDetails, WorkerResult } from "./contracts.js";
import { EMPTY_LOCATION, EMPTY_TRANSIT } from "./contracts.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createComplaintService, sanitizeTransit } from "../services/complaints.js";
import { canonicalSubwayLine, effectiveTarget, isMaterialChange, isOpenDataBacked, isRealOnly, mergeTransit, missingFields, requiresContactName, transitHintsFromText } from "./knowledge.js";
import { verifyReceipt } from "../services/receipts.js";
import { postValidate } from "../services/classifier.js";
import { isDelayAlert, parseAlerts, routeIdsForLine } from "../integrations/mta-alerts.js";
import { looksLikeTransit } from "./orchestrator.js";

const T = (p: Partial<TransitDetails>): TransitDetails => ({ ...EMPTY_TRANSIT, ...p });
const base = { rationale: "", alternativeConsidered: null, safetyFlags: [] as string[], clarifyingQuestion: null };
const subway = (transit: TransitDetails | null, description = "The A train was held at 14 St for 25 minutes."): ClassificationResult => ({
  ...base,
  triage: "SUPPORTED",
  category: "subway-delay",
  confidence: 0.92,
  description,
  transit,
});

describe("category-aware missingFields", () => {
  const draft = { category: "subway-delay" as const, location: { ...EMPTY_LOCATION }, description: "Train held in the tunnel for 20 minutes.", transit: null as TransitDetails | null };
  it("subway-delay needs transit (line + direction), not location", () => {
    expect(missingFields(draft)).toEqual(["transit"]);
    expect(missingFields({ ...draft, transit: T({ line: "A" }) })).toEqual(["transit"]);
    expect(missingFields({ ...draft, transit: T({ line: "A", direction: "downtown" }) })).toEqual([]);
  });
  it("street categories still need location and never transit", () => {
    expect(missingFields({ ...draft, category: "street-pothole" })).toEqual(["location"]);
    expect(missingFields({ ...draft, category: null })).toEqual(["category", "location"]);
  });
  it("category flags", () => {
    expect(isRealOnly("subway-delay")).toBe(true);
    expect(isRealOnly("street-pothole")).toBe(false);
    expect(isOpenDataBacked("subway-delay")).toBe(false);
    expect(effectiveTarget("subway-delay", "demo")).toBe("real");
    expect(effectiveTarget("street-pothole", "demo")).toBe("demo");
    expect(requiresContactName("subway-delay", "demo")).toBe(false);
    expect(requiresContactName("street-pothole", "real")).toBe(true);
    expect(requiresContactName("street-pothole", "demo")).toBe(false);
  });
});

describe("transit parsing + merging", () => {
  it("canonical lines", () => {
    expect(canonicalSubwayLine("A train")).toBe("A");
    expect(canonicalSubwayLine("the 7")).toBe("7");
    expect(canonicalSubwayLine("L")).toBe("L");
    expect(canonicalSubwayLine("l line")).toBe("L");
    expect(canonicalSubwayLine("42nd St shuttle")).toBe("S-42 Street Shuttle");
    expect(canonicalSubwayLine("LIRR")).toBeNull();
    expect(canonicalSubwayLine(null)).toBeNull();
  });
  it("deterministic hints from short answers", () => {
    expect(transitHintsFromText("the A")).toEqual({ line: "A" });
    expect(transitHintsFromText("downtown")).toEqual({ direction: "downtown" });
    expect(transitHintsFromText("I took a train to work")).toEqual({});
    expect(transitHintsFromText("Q train, Manhattan-bound").line).toBe("Q");
  });
  it("merge never erases a known value with null; new values win", () => {
    const m = mergeTransit(T({ line: "A", direction: "downtown" }), T({ station: "14 St", line: null }));
    expect(m).toMatchObject({ line: "A", direction: "downtown", station: "14 St" });
    expect(mergeTransit(m, T({ line: "C" }))?.line).toBe("C");
    expect(mergeTransit(null, null)).toBeNull();
  });
  it("sanitize drops invented / invalid values", () => {
    expect(sanitizeTransit(T({ line: "A train", incidentTime: "not a date", delayMinutes: -3 }))).toMatchObject({ line: "A", incidentTime: null, delayMinutes: null });
    expect(postValidate({ ...base, triage: "SUPPORTED", category: "street-pothole", confidence: 0.9, description: "hole", transit: T({ line: "A" }) }).transit).toBeNull();
  });
});

describe("subway draft conversation memory", () => {
  it("merges transit across messages, asks only for what's missing, and a transit change is material", async () => {
    const store = createMemoryStore();
    const svc = createComplaintService(store);
    let d = await svc.newDraft("c", "r");
    const first = svc.applyClassification(d, subway(T({ line: "A", station: "14 St", delayMinutes: 25 })));
    expect(first.decision.kind).toBe("CONTINUE");
    d = first.draft;
    expect(d.missingFields).toEqual(["transit"]);
    expect(d.missingFields).not.toContain("location");
    // second message only gives the direction; classifier returns line null ⇒ line kept
    const second = svc.applyClassification(d, subway(T({ direction: "downtown" })));
    d = second.draft;
    expect(d.transit).toMatchObject({ line: "A", direction: "downtown", station: "14 St", delayMinutes: 25 });
    expect(d.missingFields).toEqual([]);
    // an unclear follow-up keeps everything
    const third = svc.applyClassification(d, { ...base, triage: "UNCLEAR", category: null, confidence: 0.3, description: "", transit: null, clarifyingQuestion: "?" });
    expect(third.draft.transit?.line).toBe("A");
    expect(third.draft.category).toBe("subway-delay");
    // correcting the line bumps the version (approval invalidated)
    const fixed = svc.setTransit(d, { line: "C" });
    expect(isMaterialChange(d, fixed)).toBe(true);
    expect(fixed.draftVersion).toBe(d.draftVersion + 1);
  });
  it("subway card shows line/direction, where it's filed and the honesty rule", async () => {
    const svc = createComplaintService(createMemoryStore());
    let d = await svc.newDraft("c", "r");
    d = svc.applyClassification(d, subway(T({ line: "A", direction: "downtown", station: "14 St", incidentTime: "2026-10-16T08:30:00-04:00", delayMinutes: 25 }))).draft;
    const card = svc.buildSummary(d, { target: "real", alertLine: "MTA currently reports: delays" });
    expect(card).toContain("<b>Line &amp; direction:</b> A train, downtown");
    expect(card).toContain("<b>Station:</b> 14 St");
    expect(card).toContain("8:30 AM, Oct 16");
    expect(card).toContain("MTA Customer Feedback — Subways › Complaint › Service and schedule › Delay");
    expect(card).toContain("This files a real complaint with the MTA. Only approve if this actually happened to you.");
    expect(card).not.toContain("Location:");
  });
  it("station text is not mistaken for an address", () => {
    expect(looksLikeTransit("The A train sat at 14 St for 25 minutes this morning around 8:30, downtown")).toBe(true);
    expect(looksLikeTransit("Pothole at W 42nd St & 7th Ave")).toBe(false);
  });
});

describe("MTA receipts + alerts", () => {
  const r = (p: Partial<WorkerResult>): WorkerResult => ({
    attemptId: "a",
    status: "SUBMITTED",
    errorCode: null,
    officialRequestNumber: "06212345",
    officialReceiptUrl: null,
    confirmationText: "Thank you. Your reference number is 06212345.",
    submitClicked: true,
    finalUrl: null,
    steps: [],
    evidence: [{ name: "06-confirm.png", type: "screenshot", step: "confirm", summary: "" }],
    startedAt: "",
    finishedAt: "",
    ...p,
  });
  it("subway-delay accepts MTA reference numbers; missing pieces ⇒ SUBMISSION_UNKNOWN after submit", () => {
    expect(verifyReceipt(r({}), "real", "subway-delay").status).toBe("SUBMITTED");
    expect(verifyReceipt(r({ officialRequestNumber: "CAS-01234-X9Y8" }), "real", "subway-delay").status).toBe("SUBMITTED");
    expect(verifyReceipt(r({ confirmationText: "" }), "real", "subway-delay").status).toBe("SUBMISSION_UNKNOWN");
    expect(verifyReceipt(r({ officialRequestNumber: "ab" }), "real", "subway-delay").status).toBe("SUBMISSION_UNKNOWN");
    expect(verifyReceipt(r({ evidence: [], submitClicked: false }), "real", "subway-delay").status).toBe("FAILED");
  });
  it("dry run passes through as HUMAN_ACTION_REQUIRED with no error code", () => {
    const v = verifyReceipt(r({ status: "HUMAN_ACTION_REQUIRED", officialRequestNumber: null, submitClicked: false }), "real", "subway-delay");
    expect(v).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: null, verified: false });
  });
  it("parses GTFS-RT alerts and matches delay alerts per line", () => {
    const now = 1_792_160_000;
    const feed = {
      entity: [
        { id: "1", alert: { active_period: [{ start: now - 100 }], informed_entity: [{ route_id: "A" }, { route_id: "H" }], header_text: { translation: [{ language: "en", text: "[A][H] trains are running with delays" }, { language: "en-html", text: "<p>x</p>" }] }, "transit_realtime.mercury_alert": { alert_type: "Delays" } } },
        { id: "2", alert: { active_period: [{ start: now + 9999 }], informed_entity: [{ route_id: "L" }], header_text: { translation: [{ language: "en", text: "future" }] }, "transit_realtime.mercury_alert": { alert_type: "Delays" } } },
        { id: "3", alert: { active_period: [], informed_entity: [{ route_id: "A" }], header_text: { translation: [{ language: "en", text: "planned" }] }, "transit_realtime.mercury_alert": { alert_type: "Planned - Part Suspended" } } },
      ],
    };
    const alerts = parseAlerts(feed, now);
    expect(alerts.map((a) => [a.id, a.active])).toEqual([["1", true], ["2", false], ["3", true]]);
    expect(alerts.filter(isDelayAlert).map((a) => a.id)).toEqual(["1"]);
    expect(alerts[0]!.header).toBe("[A][H] trains are running with delays");
    expect(routeIdsForLine("S-42 Street Shuttle")).toEqual(["GS"]);
    expect(routeIdsForLine("7")).toEqual(["7", "7X"]);
  });
});
