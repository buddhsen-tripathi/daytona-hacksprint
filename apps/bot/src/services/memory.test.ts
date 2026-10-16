import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClassificationResult, ComplaintDraft, Store, WorkerResult } from "../core/contracts.js";
import { EMPTY_LOCATION, EMPTY_TRANSIT, nowIso } from "../core/contracts.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createSurrealStore, type SurrealStore } from "../integrations/surrealdb.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createOrchestrator } from "../core/orchestrator.js";
import { buildForm } from "./filing.js";
import { ASK_KIND, askFromOutcome, askHints, filterRelated, memoryCardLine, recordAskPattern, relatedCardLines } from "./memory.js";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function draft(over: Partial<ComplaintDraft> & { id: string }): ComplaintDraft {
  const t = nowIso();
  return {
    telegramChatId: "rider-1",
    residentId: "res_rider-1",
    status: "READY_FOR_APPROVAL",
    category: "subway-delay",
    triage: "SUPPORTED",
    description: "A train delayed",
    userMessages: [],
    location: { ...EMPTY_LOCATION },
    media: [],
    classification: null,
    transit: { ...EMPTY_TRANSIT, line: "A" },
    missingFields: [],
    needsEmergencyReferral: false,
    confidence: 0.9,
    duplicates: [],
    duplicateReviewed: true,
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

const pin = (lat: number, lon: number) => ({ ...EMPTY_LOCATION, latitude: lat, longitude: lon, source: "pin" as const, userConfirmed: true, withinNyc: true });

/** Fixture: the current draft + my earlier dry run + other riders on the A / C / long ago + location-only reports nearby (geo path, for location categories). */
async function seedRelated(store: Store) {
  const rows = [
    draft({ id: "cmp_now", createdAt: ago(0), status: "READY_FOR_APPROVAL" }),
    draft({ id: "cmp_mine", createdAt: ago(42), status: "HUMAN_ACTION_REQUIRED", statusReason: "dry-run: stopped before final submit" }),
    draft({ id: "cmp_mine_old", createdAt: ago(60 * 30), status: "TRACKING", officialRequestNumber: "MTA-1" }),
    draft({ id: "cmp_o1", telegramChatId: "rider-2", residentId: "res_rider-2", createdAt: ago(20) }),
    draft({ id: "cmp_o2", telegramChatId: "rider-3", residentId: "res_rider-3", createdAt: ago(35), status: "TRACKING", officialRequestNumber: "MTA-2" }),
    draft({ id: "cmp_o_cancel", telegramChatId: "rider-4", residentId: "res_rider-4", createdAt: ago(10), status: "CANCELLED" }),
    draft({ id: "cmp_o_c_line", telegramChatId: "rider-5", residentId: "res_rider-5", createdAt: ago(10), transit: { ...EMPTY_TRANSIT, line: "C" } }),
    draft({ id: "cmp_o_old", telegramChatId: "rider-6", residentId: "res_rider-6", createdAt: ago(60 * 5) }),
    // location-based (no line): 14 m and ~300 m away
    draft({ id: "cmp_pot_now", category: "subway-delay", transit: null, location: pin(40.7359, -73.9911), createdAt: ago(0) }),
    draft({ id: "cmp_pot_near", category: "subway-delay", transit: null, location: pin(40.736, -73.9912), telegramChatId: "res-x", residentId: "res_x", createdAt: ago(30) }),
    draft({ id: "cmp_pot_far", category: "subway-delay", transit: null, location: pin(40.7386, -73.9911), telegramChatId: "res-y", residentId: "res_y", createdAt: ago(30) }),
  ];
  for (const r of rows) await store.saveComplaint(r);
}

const subwayQ = { complaintId: "cmp_now", chatId: "rider-1", category: "subway-delay" as const, line: "A" };

function expectSubwayRelated(r: Awaited<ReturnType<NonNullable<Store["findRelatedComplaints"]>>>) {
  expect(r.mine.map((m) => m.id)).toEqual(["cmp_mine"]);
  expect(r.others.residents).toBe(2);
  expect(r.others.ids.sort()).toEqual(["cmp_o1", "cmp_o2"]);
  const lines = relatedCardLines(subwayQ, r);
  expect(lines[0]).toMatch(/^🔁 You reported an A train delay 4[12] min ago \(dry run, nothing sent\)\. File another\?$/);
  expect(lines[1]).toBe("👥 2 other riders reported A train delays in the last hour.");
}

describe("memory: remembered issues + learned questions (SurrealDB embedded)", () => {
  let store: SurrealStore;
  beforeAll(async () => {
    store = createSurrealStore({ url: "mem://", isolated: true });
    await store.init();
    await seedRelated(store);
  }, 30_000);
  afterAll(async () => {
    await store?.close();
  });

  it("findRelatedComplaints (subway): same line, my 24 h vs other riders' 2 h, counts only", async () => {
    expectSubwayRelated(await store.findRelatedComplaints!(subwayQ));
  });

  it("findRelatedComplaints (location): geo::distance within 100 m", async () => {
    const r = await store.findRelatedComplaints!({ complaintId: "cmp_pot_now", chatId: "rider-1", category: "subway-delay", lat: 40.7359, lon: -73.9911 });
    expect(r.others.ids).toEqual(["cmp_pot_near"]);
    expect(relatedCardLines({ category: "subway-delay" }, r)[0]).toMatch(/^👥 1 other resident reported .+ within 100 m in the last hour\.$/);
  });

  it("RELATEs complaint->similar_to->complaint for the dashboard graph", async () => {
    await store.linkSimilarComplaints!("cmp_now", ["cmp_mine", "cmp_o1", "cmp_now"]);
    const g = await store.graph();
    const sim = g.edges.filter((e) => e.rel === "similar_to" && e.from === "cmp_now").map((e) => e.to).sort();
    expect(sim).toEqual(["cmp_mine", "cmp_o1"]);
  });

  it("recordAskPattern upserts by category+field and increments count", async () => {
    const route = { target: "real" as const, category: "subway-delay" as const };
    const observation = { field: "direction", prompt: "Which direction was the A train going?", options: ["Uptown (Inwood-207 St)", "Downtown & Queens"] };
    await recordAskPattern(store, { ...route, observation, attemptId: "att_1", outcome: "HUMAN_ACTION_REQUIRED" });
    await recordAskPattern(store, { ...route, observation, attemptId: "att_1", outcome: "HUMAN_ACTION_REQUIRED" }); // same attempt: no double count
    await recordAskPattern(store, { ...route, observation, attemptId: "att_2", outcome: "HUMAN_ACTION_REQUIRED" });
    const patterns = (await store.getWorkflowPatterns(route)).filter((p) => p.kind === ASK_KIND);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.hint).toMatchObject({ field: "direction", count: 2, attemptIds: ["att_1", "att_2"] });
    expect(memoryCardLine(askHints(patterns))).toBe("🧠 <i>Learned from 2 earlier filings: asked for the direction up front.</i>");
    // learned edges: filing_attempt->learned->workflow_pattern
    const [rows] = await store.query<[{ n: number }[]]>("SELECT count() AS n FROM learned WHERE out = type::record('workflow_pattern', $id) GROUP ALL", { id: patterns[0]!.id });
    expect(rows[0]?.n).toBe(2);
  });
});

describe("memory: store parity + parsing", () => {
  it("memory store findRelatedComplaints matches the SurrealQL semantics", async () => {
    const store = createMemoryStore();
    await seedRelated(store);
    expectSubwayRelated(await store.findRelatedComplaints!(subwayQ));
    expect(filterRelated([], subwayQ).mine).toEqual([]);
  });

  it("askFromOutcome reads the stalled field (needField data) and live questions", () => {
    const res = (steps: WorkerResult["steps"], message: string | null): WorkerResult => ({
      attemptId: "a",
      status: "HUMAN_ACTION_REQUIRED",
      errorCode: "UNEXPECTED_REQUIRED_FIELD",
      officialRequestNumber: null,
      officialReceiptUrl: null,
      confirmationText: null,
      submitClicked: false,
      finalUrl: null,
      steps,
      evidence: [],
      message,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    const msg = 'Which direction was the A train going? The MTA form offers: "Uptown" or "Downtown & Queens" ("towards Manhattan" does not clearly match one of them).';
    const stalled = res([{ ts: nowIso(), step: "fill", level: "warn", message: `outcome HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD: ${msg}`, data: { field: "transit.direction", options: ["Uptown (Inwood-207 St)", "Downtown & Queens"], optionsShort: ["Uptown", "Downtown & Queens"] } }], msg);
    expect(askFromOutcome("HUMAN_ACTION_REQUIRED", "UNEXPECTED_REQUIRED_FIELD", stalled)).toEqual([
      { field: "direction", prompt: 'Which direction was the A train going? The MTA form offers: "Uptown" or "Downtown & Queens".', options: ["Uptown", "Downtown & Queens"] },
    ]);
    expect(askFromOutcome("HUMAN_ACTION_REQUIRED", null, stalled)).toEqual([]);
    const live = res([{ ts: nowIso(), step: "fill", level: "warn", message: "question", data: { question: { id: "q1", field: "station", prompt: "Which station?", required: true } } }], null);
    expect(askFromOutcome("SUBMITTED", null, { ...live, status: "SUBMITTED", errorCode: null })).toEqual([{ field: "station", prompt: "Which station?" }]);
    const unknown = res([{ ts: nowIso(), step: "fill", level: "warn", message: "outcome", data: { fields: [{ label: "MetroCard number (required)" }] } }], "The MTA form now requires: MetroCard number (required).");
    expect(askFromOutcome("HUMAN_ACTION_REQUIRED", "UNEXPECTED_REQUIRED_FIELD", unknown)[0]?.field).toBe("metrocard_number_required");
  });
});

describe("memory: orchestrator asks learned fields up front and remembers your last report", () => {
  const classification: ClassificationResult = {
    triage: "SUPPORTED",
    category: "subway-delay",
    confidence: 0.95,
    description: "The A train was held at 14 St for 25 minutes.",
    rationale: "",
    alternativeConsidered: null,
    safetyFlags: [],
    clarifyingQuestion: null,
    transit: { line: "A", direction: "downtown", station: "14 St", borough: null, incidentTime: new Date().toISOString(), delayMinutes: 25 },
  };

  it("asks a learned free-text field, stores it in draft.extraFields → payload.form.extraFields, shows the memory + remembered lines", async () => {
    const store = createMemoryStore();
    await recordAskPattern(store, { target: "real", category: "subway-delay", observation: { field: "car_number", prompt: "The MTA form asked for the car number." }, attemptId: "att_seed", outcome: "HUMAN_ACTION_REQUIRED" });
    const transport = createCaptureTransport();
    const orch = createOrchestrator({
      store,
      tracer: createNoopTracer(),
      classifier: { classify: async () => ({ result: classification, model: "stub", usage: { promptTokens: null, completionTokens: null } }) },
      location: { fromPin: async () => ({ ...EMPTY_LOCATION }), fromText: async () => null, withinNyc: () => true },
      duplicates: { findPotentialDuplicates: async () => ({ candidates: [], dataAsOf: null, source: "open-data" }), lookupStatus: async () => null },
      filing: { executeFiling: async () => ({ complaintId: "x", attemptId: "none", status: "FAILED", errorCode: "SANDBOX_ERROR", message: "stub" }) },
      transport,
      mtaAlerts: async () => ({ alerts: [], source: "unavailable" }) as never,
    });
    let n = 0;
    const text = (t: string) => orch.handle({ kind: "text", chatId: "rider-9", updateId: `u${++n}`, text: t, username: null });

    await text("The A train sat at 14 St for 25 minutes, downtown");
    const ask = transport.messages[transport.messages.length - 1]!;
    expect(ask.text).toContain("Learned from 1 earlier filing");
    expect(ask.text).toContain("The MTA form asked for the car number.");
    await text("8512");
    const card = transport.messages[transport.messages.length - 1]!;
    expect(card.text).toContain("Here's your MTA complaint");
    expect(card.text).toContain("🧠 <i>Learned from 1 earlier filing: asked for “car number” up front.</i>");
    const d = (await store.listComplaints({ chatId: "rider-9", limit: 1 }))[0]!;
    expect(d.status).toBe("READY_FOR_APPROVAL");
    expect(d.extraFields).toEqual({ car_number: "8512" });
    const resident = await store.getOrCreateResident("rider-9", null);
    expect(buildForm(d, resident, "real").extraFields).toEqual({ car_number: "8512" });

    // second report on the same line: remembered, Approve still offered, learned question not re-asked (answer kept per draft → asked again for a new draft)
    await orch.handle({ kind: "command", chatId: "rider-9", updateId: `u${++n}`, command: "report", args: "", username: null });
    await text("The A train sat at 14 St for 25 minutes, downtown");
    await text("skip");
    const card2 = transport.messages[transport.messages.length - 1]!;
    expect(card2.text).toMatch(/🔁 You reported an A train delay (just now|\d+ min ago) \(cancelled, not filed\)\. File another\?/);
    expect((card2.buttons ?? []).flat().some((b) => b.data?.startsWith("approve:"))).toBe(true);

    const mr = transport.messages.length;
    await orch.handle({ kind: "command", chatId: "rider-9", updateId: `u${++n}`, command: "myreports", args: "", username: null });
    expect(transport.messages[mr]!.text).toMatch(/Subway delay · A train, .* · <i>waiting for your approval<\/i> · Oct|[A-Z][a-z]{2} \d+/);
  });
});
