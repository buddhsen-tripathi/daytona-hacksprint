import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComplaintDraft, DuplicateCandidate, FilingAttempt } from "../core/contracts.js";
import { CATEGORIES, EMPTY_LOCATION, nowIso } from "../core/contracts.js";
import { StoreError, createSurrealStore, type SurrealStore } from "./surrealdb.js";

function draft(over: Partial<ComplaintDraft> = {}): ComplaintDraft {
  const t = nowIso();
  return {
    id: "cmp_test1",
    telegramChatId: "chat-1",
    residentId: "res_chat-1",
    status: "RECEIVED",
    category: null,
    triage: null,
    description: "Pothole in the left lane",
    userMessages: ["there is a pothole"],
    location: { ...EMPTY_LOCATION },
    media: [],
    classification: null,
    missingFields: ["location"],
    needsEmergencyReferral: false,
    confidence: 0,
    duplicates: [],
    duplicateReviewed: false,
    draftVersion: 1,
    approvedVersion: null,
    approvedAt: null,
    activeAttemptId: null,
    officialRequestNumber: null,
    statusReason: null,
    traceId: null,
    createdAt: t,
    updatedAt: t,
    ...over,
  };
}

const loc = { latitude: 40.7359, longitude: -73.9911, address: "100 E 14th St, Manhattan", borough: "Manhattan", rawInput: null, source: "pin" as const, userConfirmed: true, withinNyc: true };

const candidate: DuplicateCandidate = {
  uniqueKey: "61234567",
  complaintType: "Street Condition",
  descriptor: "Pothole",
  status: "Open",
  createdDate: "2026-10-01T00:00:00.000",
  closedDate: null,
  resolutionDescription: null,
  incidentAddress: "102 E 14th St",
  latitude: 40.7360,
  longitude: -73.9912,
  distanceMeters: 14,
  ageDays: 15,
  matchScore: 0.82,
  scoreBreakdown: { location: 0.9, category: 1, recency: 0.6 },
};

describe("SurrealStore (embedded mem://)", () => {
  let store: SurrealStore;
  beforeAll(async () => {
    store = createSurrealStore({ url: "mem://", isolated: true });
    await store.init();
  }, 30_000);
  afterAll(async () => {
    await store?.close();
  });

  it("reports the embedded backend", () => {
    expect(store.backend).toBe("surrealdb-embedded");
  });

  it("creates residents idempotently and updates them", async () => {
    const a = await store.getOrCreateResident("chat-1", "alice");
    const b = await store.getOrCreateResident("chat-1", "alice");
    expect(a.id).toBe(b.id);
    expect(typeof a.id).toBe("string");
    const u = await store.updateResident(a.id, { demoPortalMode: "captcha", contactName: "Alice Doe" });
    expect(u.demoPortalMode).toBe("captcha");
    expect((await store.getOrCreateResident("chat-1", null)).contactName).toBe("Alice Doe");
  });

  it("round-trips complaints and resolves the active one", async () => {
    await store.createComplaint(draft());
    const got = await store.getComplaint("cmp_test1");
    expect(got?.id).toBe("cmp_test1");
    expect(got?.location).toEqual(EMPTY_LOCATION);
    expect((await store.getActiveComplaint("chat-1"))?.id).toBe("cmp_test1");

    await store.saveComplaint(draft({ status: "READY_FOR_APPROVAL", category: "street-pothole", location: loc, draftVersion: 2 }));
    const saved = await store.getComplaint("cmp_test1");
    expect(saved?.category).toBe("street-pothole");
    expect(saved?.draftVersion).toBe(2);

    await store.saveComplaint(draft({ status: "CANCELLED", category: "street-pothole", location: loc }));
    expect(await store.getActiveComplaint("chat-1")).toBeNull();
    expect((await store.listComplaints({ chatId: "chat-1" })).map((c) => c.id)).toEqual(["cmp_test1"]);
    expect(await store.getComplaint("missing")).toBeNull();
    await store.recordTransition("cmp_test1", "READY_FOR_APPROVAL", "CANCELLED", "user cancelled", "user");
  });

  it("marks telegram updates processed exactly once", async () => {
    expect(await store.markUpdateProcessed("u-1")).toBe(true);
    expect(await store.markUpdateProcessed("u-1")).toBe(false);
  });

  it("links duplicates, attempts, official requests and patterns into a graph", async () => {
    await store.saveComplaint(draft({ id: "cmp_g", status: "DUPLICATE_REVIEW", category: "street-pothole", location: loc }));
    await store.linkDuplicates("cmp_g", [candidate]);
    const attempt: FilingAttempt = {
      id: "att_g",
      complaintId: "cmp_g",
      approvedVersion: 1,
      target: "demo",
      category: "street-pothole",
      sandboxId: "sbx",
      sandboxProvider: "local",
      browserSessionId: null,
      browserProvider: "local",
      liveViewUrl: null,
      recordingUrl: null,
      outcome: "SUBMITTED",
      errorCode: null,
      officialRequestNumber: "DEMO-20261016-ABC123",
      verified: true,
      verificationNotes: null,
      evidence: [],
      workerEvents: [],
      traceId: null,
      traceUrl: null,
      timing: { sandboxMs: 1, browserMs: 1, workerMs: 1, totalMs: 3 },
      createdAt: nowIso(),
      finishedAt: nowIso(),
    };
    await store.createAttempt(attempt);
    await store.saveAttempt({ ...attempt, verificationNotes: "ok" });
    expect((await store.getAttempt("att_g"))?.verificationNotes).toBe("ok");
    expect((await store.listAttempts({ complaintId: "cmp_g" })).length).toBe(1);

    await store.saveOfficialRequest({
      id: "or_g",
      complaintId: "cmp_g",
      officialRequestNumber: "DEMO-20261016-ABC123",
      officialCategory: "Pothole or Cave-In on Street",
      status: "Open",
      statusSource: "demo-portal",
      lastCheckedAt: nowIso(),
      receiptUrl: null,
    });
    const ors = await store.listOfficialRequests("chat-1");
    expect(ors.map((o) => o.id)).toEqual(["or_g"]); // open-data duplicates excluded

    await store.recordWorkflowPattern({
      id: "wp_g",
      target: "demo",
      category: "street-pothole",
      kind: "captcha-after-submit",
      description: "stop on captcha",
      hint: { stopOn: "captcha" },
      observedInAttemptId: "att_g",
      outcome: "HUMAN_ACTION_REQUIRED",
      createdAt: nowIso(),
    });
    expect((await store.getWorkflowPatterns({ target: "demo", category: "street-pothole" })).map((p) => p.id)).toEqual(["wp_g"]);
    expect(await store.getWorkflowPatterns({ target: "real", category: "street-pothole" })).toEqual([]);

    const g = await store.graph({ complaintId: "cmp_g" });
    const rels = new Set(g.edges.map((e) => e.rel));
    for (const r of ["reported", "located_at", "categorized_as", "possibly_duplicates", "attempted", "resulted_in", "learned"]) expect(rels).toContain(r);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of ["resident", "complaint", "location", "category", "official_request", "filing_attempt", "workflow_pattern"]) expect(kinds).toContain(k);
    expect(g.nodes.every((n) => typeof n.id === "string" && !n.id.includes(":"))).toBe(true);

    const full = await store.graph();
    expect(full.nodes.length).toBeGreaterThanOrEqual(g.nodes.length);

    // geo query over the location table
    const [near] = await store.query<[{ address: string }[]]>(
      "SELECT address FROM location WHERE point != NONE AND geo::distance(point, <geometry<point>> [$lon, $lat]) < 100",
      { lon: -73.9911, lat: 40.7359 },
    );
    expect(near.length).toBeGreaterThanOrEqual(1);
  });

  it("throws a typed StoreError on DB failure", async () => {
    await expect(store.query("THROW 'boom'")).rejects.toBeInstanceOf(StoreError);
  });

  it("reset clears data but keeps categories", async () => {
    await store.reset();
    expect(await store.listComplaints()).toEqual([]);
    const [cats] = await store.query<[unknown[]]>("SELECT * FROM complaint_category");
    expect(cats.length).toBe(Object.keys(CATEGORIES).length);
  });
});
