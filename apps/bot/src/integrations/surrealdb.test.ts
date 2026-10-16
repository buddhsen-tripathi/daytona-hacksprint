import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Surreal } from "surrealdb";
import type { ComplaintDraft, DuplicateCandidate, FilingAttempt } from "../core/contracts.js";
import { CATEGORIES, EMPTY_LOCATION, nowIso } from "../core/contracts.js";
import { StoreError, createSurrealStore, type SurrealStore } from "./surrealdb.js";
import { createMemoryStore } from "./memory-store.js";
import { fileableCatalogEntries } from "../services/catalog-crawl.js";

describe("memory store catalog (#28)", () => {
  it("upserts by id and lists sorted", async () => {
    const m = createMemoryStore();
    const [e] = fileableCatalogEntries("2026-10-16T00:00:00.000Z");
    await m.upsertCatalog([{ ...e, id: "zz" }, e]);
    await m.upsertCatalog([{ ...e, title: "renamed" }]);
    expect((await m.listCatalog()).map((r) => [r.id, r.title])).toEqual([
      [e.id, "renamed"],
      ["zz", e.title],
    ]);
  });
});

function draft(over: Partial<ComplaintDraft> = {}): ComplaintDraft {
  const t = nowIso();
  return {
    id: "cmp_test1",
    telegramChatId: "chat-1",
    residentId: "res_chat-1",
    status: "RECEIVED",
    category: null,
    triage: null,
    description: "The A train was held at 14 St for 25 minutes",
    userMessages: ["A train stuck at 14 St"],
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
    const u = await store.updateResident(a.id, { contactName: "Alice Doe", contactEmail: "alice@example.com" });
    expect(u.contactEmail).toBe("alice@example.com");
    expect((await store.getOrCreateResident("chat-1", null)).contactName).toBe("Alice Doe");
  });

  it("round-trips complaints and resolves the active one", async () => {
    await store.createComplaint(draft());
    const got = await store.getComplaint("cmp_test1");
    expect(got?.id).toBe("cmp_test1");
    expect(got?.location).toEqual(EMPTY_LOCATION);
    expect((await store.getActiveComplaint("chat-1"))?.id).toBe("cmp_test1");

    await store.saveComplaint(draft({ status: "READY_FOR_APPROVAL", category: "subway-delay", location: loc, draftVersion: 2 }));
    const saved = await store.getComplaint("cmp_test1");
    expect(saved?.category).toBe("subway-delay");
    expect(saved?.draftVersion).toBe(2);

    await store.saveComplaint(draft({ status: "CANCELLED", category: "subway-delay", location: loc }));
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
    await store.saveComplaint(draft({ id: "cmp_g", status: "DUPLICATE_REVIEW", category: "subway-delay", location: loc }));
    await store.linkDuplicates("cmp_g", [candidate]);
    const attempt: FilingAttempt = {
      id: "att_g",
      complaintId: "cmp_g",
      approvedVersion: 1,
      target: "real",
      category: "subway-delay",
      sandboxId: "sbx",
      sandboxProvider: "local",
      browserSessionId: null,
      browserProvider: "local",
      liveViewUrl: null,
      recordingUrl: null,
      outcome: "SUBMITTED",
      errorCode: null,
      officialRequestNumber: "31124680",
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
      officialRequestNumber: "31124680",
      officialCategory: CATEGORIES["subway-delay"].officialLabel,
      status: "Open",
      statusSource: "confirmation",
      lastCheckedAt: nowIso(),
      receiptUrl: null,
    });
    const ors = await store.listOfficialRequests("chat-1");
    expect(ors.map((o) => o.id)).toEqual(["or_g"]); // open-data duplicates excluded

    await store.recordWorkflowPattern({
      id: "wp_g",
      target: "real",
      category: "subway-delay",
      kind: "captcha-after-submit",
      description: "stop on captcha",
      hint: { stopOn: "captcha" },
      observedInAttemptId: "att_g",
      outcome: "HUMAN_ACTION_REQUIRED",
      createdAt: nowIso(),
    });
    expect((await store.getWorkflowPatterns({ target: "real", category: "subway-delay" })).map((p) => p.id)).toEqual(["wp_g"]);

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

  it("upserts and lists catalog rows; reset keeps them (#28)", async () => {
    const [e] = fileableCatalogEntries("2026-10-16T00:00:00.000Z");
    const row = { ...e, id: "gas-leak", kaNumber: "KA-02048", automation: "none", officialUrl: null, emergency: true };
    expect(await store.upsertCatalog([row])).toBe(1);
    expect((await store.listCatalog()).find((r) => r.id === "gas-leak")).toMatchObject({ emergency: true, kaNumber: "KA-02048" });
    await store.reset();
    expect((await store.listCatalog()).map((r) => r.id)).toContain("gas-leak");
    await store.query("DELETE complaint_category WHERE catalog = true");
  });

  it("repair proposals (#13): upsert, get, list by status (newest first), reset clears them", async () => {
    const base = { cause: "missing_required_field" as const, confidence: 0.7, attemptId: "att_1", complaintId: "cmp_1", category: "subway-delay" as const, decidedAt: null };
    const change = { kind: "requiredField" as const, before: null, after: "Cross Street 2", evidence: ["ev_1"] };
    await store.saveRepairProposal!({ ...base, id: "rep_a", proposedChanges: [change], status: "pending", createdAt: "2026-10-16T10:00:00.000Z" });
    await store.saveRepairProposal!({ ...base, id: "rep_b", proposedChanges: [], status: "rejected", createdAt: "2026-10-16T11:00:00.000Z" });
    expect(await store.getRepairProposal!("rep_a")).toMatchObject({ id: "rep_a", proposedChanges: [change], decidedAt: null });
    expect(await store.getRepairProposal!("rep_missing")).toBeNull();
    expect((await store.listRepairProposals!()).map((p) => p.id)).toEqual(["rep_b", "rep_a"]);
    expect((await store.listRepairProposals!({ status: "pending" })).map((p) => p.id)).toEqual(["rep_a"]);
    await store.saveRepairProposal!({ ...base, id: "rep_a", proposedChanges: [change], status: "approved", createdAt: "2026-10-16T10:00:00.000Z", decidedAt: "2026-10-16T12:00:00.000Z", decidedBy: "operator", applied: ["Cross Street 2"] });
    expect(await store.listRepairProposals!({ status: "pending" })).toEqual([]);
    expect(await store.getRepairProposal!("rep_a")).toMatchObject({ status: "approved", applied: ["Cross Street 2"] });
    // repair_proposal->from_attempt->filing_attempt
    const [edges] = await store.query<[{ out: unknown }[]]>("SELECT out FROM from_attempt WHERE in = repair_proposal:rep_a");
    expect(edges.map((e) => String(e.out))).toEqual(["filing_attempt:att_1"]);
    expect(await store.updateRepairProposal!("rep_b", { status: "pending", decidedAt: null })).toMatchObject({ id: "rep_b", status: "pending" });
    expect((await store.listRepairProposals!({ status: "pending" })).map((p) => p.id)).toEqual(["rep_b"]);
    expect(await store.updateRepairProposal!("rep_missing", { status: "approved" })).toBeNull();
    await store.reset();
    expect(await store.listRepairProposals!()).toEqual([]);
  });

  it("category overrides (#13): approved confirmRegex / questionText merge onto complaint_category", async () => {
    expect(await store.getCategoryOverrides!("subway-delay")).toBeNull();
    await store.updateCategoryOverrides!("subway-delay", { confirmRegex: "Reference #\\s*(\\d+)", repairIds: ["rep_1"] });
    await store.updateCategoryOverrides!("subway-delay", { questionTexts: { "Cross Street 2": "What is the second cross street?" }, repairIds: ["rep_2"] });
    expect(await store.getCategoryOverrides!("subway-delay")).toMatchObject({
      confirmRegex: "Reference #\\s*(\\d+)",
      questionTexts: { "Cross Street 2": "What is the second cross street?" },
      repairIds: ["rep_1", "rep_2"],
    });
  });

  it("reset clears data but keeps categories", async () => {
    await store.reset();
    expect(await store.listComplaints()).toEqual([]);
    const [cats] = await store.query<[unknown[]]>("SELECT * FROM complaint_category");
    expect(cats.length).toBe(Object.keys(CATEGORIES).length);
  });
});

describe("SurrealStore init: schema + vector-index setup inside the connect budget (#24)", () => {
  /** Every query whose SQL matches `hang` never answers. Patched by hand: vi.spyOn awaits the returned (thenable) Query, which would run every query twice. */
  async function withHungQuery(hang: RegExp, fn: () => Promise<void>) {
    const proto = Surreal.prototype as { query: Surreal["query"] };
    const original = proto.query;
    proto.query = function (this: Surreal, ...args: Parameters<Surreal["query"]>) {
      if (typeof args[0] === "string" && hang.test(args[0])) return { collect: () => new Promise(() => {}) } as unknown as ReturnType<Surreal["query"]>;
      return original.apply(this, args);
    } as Surreal["query"];
    try {
      await fn();
    } finally {
      delete (proto as { query?: unknown }).query; // inherited from SurrealQueryable
      if (proto.query !== original) proto.query = original;
    }
  }

  it("a hung HNSW DEFINE times out within the budget, warns clearly, and the store still works (exact cosine)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createSurrealStore({ url: "mem://", isolated: true, connectTimeoutMs: 1500 });
    try {
      await withHungQuery(/ HNSW /, async () => {
        const t0 = Date.now();
        await store.init();
        expect(Date.now() - t0).toBeLessThan(5000);
      });
      expect(store.vectorIndex).toBe(false);
      expect(store.knnRecall).toBe(false);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/HNSW index unavailable.*exceeded the 1500 ms connect budget.*define hnsw timed out/);
      await store.createComplaint(draft({ id: "cmp_hnsw_hang" }));
      expect((await store.getComplaint("cmp_hnsw_hang"))?.id).toBe("cmp_hnsw_hang");
    } finally {
      warn.mockRestore();
      await store.close();
    }
  }, 15_000);

  it("a hung schema DEFINE fails init within the budget (callers fall back to the in-memory store)", async () => {
    const store = createSurrealStore({ url: "mem://", isolated: true, connectTimeoutMs: 1000 });
    await withHungQuery(/DEFINE TABLE IF NOT EXISTS resident /, async () => {
      const t0 = Date.now();
      await expect(store.init()).rejects.toThrow(/define schema timed out after/);
      expect(Date.now() - t0).toBeLessThan(5000);
    });
    await store.close().catch(() => {});
  }, 15_000);
});
