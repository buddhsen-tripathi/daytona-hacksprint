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
  it("no category yet: only category is missing (location is asked only by categories that require it)", () => {
    expect(missingFields({ ...draft, category: null })).toEqual(["category"]);
  });
  it("category flags", () => {
    expect(isRealOnly("subway-delay")).toBe(true);
    expect(isRealOnly("removed-category")).toBe(false); // unknown category
    expect(isOpenDataBacked("subway-delay")).toBe(false);
    expect(effectiveTarget("subway-delay")).toBe("real");
    expect(requiresContactName("subway-delay")).toBe(false);
    expect(requiresContactName("removed-category")).toBe(false); // unknown category ⇒ no /name gate
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
    expect(postValidate({ ...base, triage: "OUT_OF_SCOPE", category: null, confidence: 0.9, description: "Pothole: hole", transit: T({ line: "A" }) }).transit).toBeNull();
    // A category outside the allowlist (e.g. a removed category) is downgraded, never filed.
    expect(postValidate({ ...base, triage: "SUPPORTED", category: "removed-category" as never, confidence: 0.9, description: "hole", transit: null })).toMatchObject({ triage: "UNCLEAR", category: null });
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

// ---------------------------------------------------------------------------
// Direction in the MTA form's own terms + incident time + composed description
// ---------------------------------------------------------------------------
import { MTA_DIRECTIONS, parseIncidentTime, resolveDirection } from "./knowledge.js";
import { composeSubwayDescription } from "../services/complaints.js";
import { createOrchestrator } from "./orchestrator.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createBoundsLocationService, createNoopTracer, createUnavailableDuplicateService, createUnavailableFilingService } from "../integrations/fallbacks.js";
import type { Classifier } from "./contracts.js";

describe("MTA direction resolution", () => {
  it("maps what riders say to exactly one MTA option, or asks", () => {
    expect(resolveDirection("A", "downtown")).toBe("Downtown & Queens");
    expect(resolveDirection("A", "southbound")).toBe("Downtown & Queens");
    expect(resolveDirection("A", "toward Inwood")).toBe("Uptown (Inwood-207 St)");
    expect(resolveDirection("A", "Manhattan-bound")).toBeNull();
    expect(resolveDirection("A", "towards Manhattan")).toBeNull();
    expect(resolveDirection("7", "Manhattan-bound")).toBe("Manhattan (34 St-Hudson Yards)");
    expect(resolveDirection("L", "to Brooklyn")).toBe("Brooklyn (Canarsie-Rockaway Pkwy)");
    expect(resolveDirection("A", null)).toBeNull();
  });
  it("every option label resolves to itself (the worker gets an exact label)", () => {
    for (const [line, opts] of Object.entries(MTA_DIRECTIONS)) for (const o of opts) expect(resolveDirection(line, o)).toBe(o);
  });
});

describe("incident time", () => {
  const now = new Date("2026-10-16T16:47:00Z"); // 12:47 PM New York (EDT)
  it("parses typed times today in New York, never in the future", () => {
    expect(parseIncidentTime("just now", now)).toBe("2026-10-16T12:47:00-04:00");
    expect(parseIncidentTime("8:30", now)).toBe("2026-10-16T08:30:00-04:00");
    expect(parseIncidentTime("around 8 this morning", now)).toBe("2026-10-16T08:00:00-04:00");
    expect(parseIncidentTime("12:15pm", now)).toBe("2026-10-16T12:15:00-04:00");
    expect(parseIncidentTime("11:30", now)).toBe("2026-10-16T11:30:00-04:00");
    expect(parseIncidentTime("5pm", now)).toBeNull();
    expect(parseIncidentTime("yesterday at 8", now)).toBeNull();
    expect(parseIncidentTime("it was bad", now)).toBeNull();
  });
});

describe("composed MTA description", () => {
  it("quotes the rider verbatim, adds only facts they gave, and attributes", () => {
    const text = composeSubwayDescription({
      userMessages: ["A train delayed towards Manhattan, sat 20 minutes at Jay St", "Downtown"],
      description: "",
      transit: T({ line: "A", direction: "Downtown & Queens", station: "Jay St-MetroTech", incidentTime: "2026-10-16T08:30:00-04:00", delayMinutes: 20 }),
    });
    expect(text).toBe(
      '"A train delayed towards Manhattan, sat 20 minutes at Jay St"\n\nLine: A · Direction: Downtown & Queens · Nearest station: Jay St-MetroTech · Observed: Oct 16, 2026, 8:30 AM · Delay: ~20 min\n\nReported through 311Relay on behalf of the rider.',
    );
  });
});

describe("orchestrator: subway direction + time before approval", () => {
  it("asks for the direction in MTA terms with two buttons, then the time, then shows the card", async () => {
    const store = createMemoryStore();
    const transport = createCaptureTransport();
    const classifier: Classifier = {
      async classify() {
        return { result: subway(T({ line: "A", direction: "Manhattan-bound", incidentTime: null }), "The A train was delayed towards Manhattan."), model: "fake", usage: { promptTokens: null, completionTokens: null } };
      },
    };
    const o = createOrchestrator({
      store,
      tracer: createNoopTracer(),
      classifier,
      location: createBoundsLocationService(),
      duplicates: createUnavailableDuplicateService(),
      filing: createUnavailableFilingService(),
      transport,
      mtaAlerts: async () => ({ alerts: [], fetchedAt: null, source: "mta" }),
    });
    let n = 0;
    const ev = (e: Record<string, unknown>) => o.handle({ chatId: "c1", updateId: `u${++n}`, username: null, ...e } as never);
    await ev({ kind: "text", text: "A train delayed towards Manhattan" });
    let last = transport.messages[transport.messages.length - 1]!;
    expect(last.text).toContain("Which way was the A going? The MTA form lists:");
    expect(last.buttons?.map((r) => r[0]!.text)).toEqual(["Uptown (Inwood-207 St)", "Downtown & Queens"]);
    expect(transport.messages.some((m) => m.requestLocation)).toBe(false);
    await ev({ kind: "callback", data: last.buttons![1]![0]!.data!, messageId: null });
    last = transport.messages[transport.messages.length - 1]!;
    expect(last.text).toContain("When did this happen?");
    const timeNow = last.buttons!.flat().find((b) => b.data?.endsWith(":now"))!.data!;
    await ev({ kind: "callback", data: timeNow, messageId: null });
    last = transport.messages[transport.messages.length - 1]!;
    expect(last.text).toContain("Line &amp; direction:</b> A train, Downtown &amp; Queens");
    expect(last.text).toContain('"A train delayed towards Manhattan"');
    expect(last.text).toContain("Reported through 311Relay on behalf of the rider.");
    expect(last.buttons?.flat().some((b) => b.data?.startsWith("approve:"))).toBe(true);
    const d = (await store.listComplaints({ chatId: "c1" }))[0]!;
    expect(d.status).toBe("READY_FOR_APPROVAL");
    expect(d.transit).toMatchObject({ line: "A", direction: "Downtown & Queens" });
    expect(d.transit?.incidentTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00-0[45]:00$/);
    expect(d.description).toContain("Direction: Downtown & Queens");
  });

  it("accepts a typed direction answer", async () => {
    const store = createMemoryStore();
    const transport = createCaptureTransport();
    let calls = 0;
    const classifier: Classifier = {
      async classify() {
        calls++;
        return { result: subway(T({ line: "A", direction: "Manhattan-bound", incidentTime: "2026-10-16T08:30:00-04:00" })), model: "fake", usage: { promptTokens: null, completionTokens: null } };
      },
    };
    const o = createOrchestrator({ store, tracer: createNoopTracer(), classifier, location: createBoundsLocationService(), duplicates: createUnavailableDuplicateService(), filing: createUnavailableFilingService(), transport, mtaAlerts: async () => ({ alerts: [], fetchedAt: null, source: "mta" }) });
    let n = 0;
    await o.handle({ chatId: "c2", updateId: `v${++n}`, username: null, kind: "text", text: "A train delayed towards Manhattan at 8:30" });
    await o.handle({ chatId: "c2", updateId: `v${++n}`, username: null, kind: "text", text: "uptown" });
    expect(calls).toBe(1);
    const d = (await store.listComplaints({ chatId: "c2" }))[0]!;
    expect(d.status).toBe("READY_FOR_APPROVAL");
    expect(d.transit?.direction).toBe("Uptown (Inwood-207 St)");
    expect(d.description.startsWith('"A train delayed towards Manhattan at 8:30"')).toBe(true);
  });
});
