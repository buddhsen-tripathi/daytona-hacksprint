/**
 * #4 step 4: memory reads go through AgentMemory.recall() without changing behaviour, and GET /api/memory.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClassificationResult, ComplaintDraft, ScoredMemory, Store } from "../core/contracts.js";
import { EMPTY_LOCATION, EMPTY_TRANSIT, nowIso } from "../core/contracts.js";
import { createOrchestrator, type Orchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createSurrealStore, type SurrealStore } from "../integrations/surrealdb.js";
import { askPatternItem, createAgentMemory, readyForApprovalItem } from "./agent-memory.js";
import { askHints, readAskPatterns, readRelated, recordAskPattern } from "./memory.js";

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

async function seed(store: Store) {
  const rows = [
    draft({ id: "cmp_now", createdAt: ago(0) }),
    draft({ id: "cmp_mine", createdAt: ago(42), status: "HUMAN_ACTION_REQUIRED", statusReason: "dry-run: stopped before final submit" }),
    draft({ id: "cmp_o1", telegramChatId: "rider-2", residentId: "res_rider-2", createdAt: ago(20) }),
  ];
  for (const r of rows) await store.saveComplaint(r);
  const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
  for (const r of rows) await memory.remember({ ...readyForApprovalItem(r), createdAt: r.createdAt });
  const p = await recordAskPattern(store, { target: "real", category: "subway-delay", observation: { field: "car_number", prompt: "Which car?" }, attemptId: "att_1", outcome: "HUMAN_ACTION_REQUIRED" });
  await memory.remember(askPatternItem(p));
  return memory;
}

const q = { complaintId: "cmp_now", chatId: "rider-1", category: "subway-delay" as const, line: "A", sinceMs: 24 * 3600_000, othersSinceMs: 2 * 3600_000, radiusMeters: 100 };

for (const [name, make] of [
  ["memory store", async () => ({ store: createMemoryStore() as Store, close: async () => {} })],
  ["SurrealDB embedded", async () => {
    const s: SurrealStore = createSurrealStore({ url: "mem://", isolated: true });
    await s.init();
    return { store: s as Store, close: () => s.close() };
  }],
] as const) {
  describe(`reads through recall() (${name})`, () => {
    let store: Store;
    let close: () => Promise<void>;
    let memory: Awaited<ReturnType<typeof seed>>;
    beforeAll(async () => {
      ({ store, close } = await make());
      memory = await seed(store);
    }, 30_000);
    afterAll(async () => close?.());

    it("readRelated: same structural result as the store; 'mine' ranked/explained by resident-scoped recall", async () => {
      const direct = await store.findRelatedComplaints!(q);
      const { related, docs } = await readRelated(store, memory, q, readyForApprovalItem(draft({ id: "cmp_now" })).text);
      expect(related).toEqual(direct);
      expect(related.mine.map((m) => m.id)).toEqual(["cmp_mine"]);
      const mine = docs.find((d) => d.id === "cmp_mine")!;
      const m = (mine.metadata as { memory: { id: string; score: number; breakdown: ScoredMemory["breakdown"] } }).memory;
      expect(m.id).toBe("mem_ready_cmp_mine");
      expect(mine.score).toBe(m.score);
      expect(m.breakdown.relevanceKind).toBe("cosine");
      // other residents: still counts only, no memory text in the docs
      const other = docs.find((d) => d.id === "cmp_o1")!;
      expect(other.content).toBe("another resident's report (same category, same line / nearby)");
      expect(other.metadata).toBeUndefined();
      // without memory: identical structural answer, legacy scores
      const bare = await readRelated(store, null, q, "x");
      expect(bare.related).toEqual(direct);
      expect(bare.docs.find((d) => d.id === "cmp_mine")!.score).toBe(1);
    });

    it("readAskPatterns: hints unchanged; documents scored by procedural memory", async () => {
      const route = { target: "real" as const, category: "subway-delay" as const };
      const patterns = await store.getWorkflowPatterns(route);
      const { hints, docs } = await readAskPatterns(store, memory, route);
      expect(hints).toEqual(askHints(patterns));
      expect(hints.map((h) => h.field)).toEqual(["car_number"]);
      const doc = docs[0]!;
      expect((doc.metadata as { memory?: { id: string } }).memory?.id).toBe(`mem_${patterns[0]!.id}`);
      expect(doc.score).toBeLessThan(1);
      expect((await readAskPatterns(store, null, route)).docs[0]!.score).toBe(1);
    });
  });
}

describe("orchestrator behaviour is identical with and without agent memory", () => {
  const classification: ClassificationResult = {
    triage: "SUPPORTED",
    category: "subway-delay",
    confidence: 0.95,
    description: "The A train was held at 14 St for 25 minutes.",
    rationale: "",
    alternativeConsidered: null,
    safetyFlags: [],
    clarifyingQuestion: null,
    transit: { line: "A", direction: "Downtown & Queens", station: "14 St", borough: null, incidentTime: new Date().toISOString(), delayMinutes: 25 },
  };
  async function conversation(withMemory: boolean) {
    const store = createMemoryStore();
    const memory = withMemory ? createAgentMemory({ store, embedder: createHashEmbedder() }) : null;
    await recordAskPattern(store, { target: "real", category: "subway-delay", observation: { field: "car_number", prompt: "The MTA form asked for the car number." }, attemptId: "att_seed", outcome: "HUMAN_ACTION_REQUIRED" });
    const transport = createCaptureTransport();
    const orch = createOrchestrator({
      store,
      memory,
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
    await text("8512");
    await memory?.flush();
    await orch.handle({ kind: "command", chatId: "rider-9", updateId: `u${++n}`, command: "report", args: "", username: null });
    await text("The A train sat at 14 St for 25 minutes, downtown");
    await text("skip");
    await memory?.flush();
    return { texts: transport.messages.map((m) => m.text.replace(/\d+ min ago|just now/g, "<ago>")), store };
  }

  it("same messages, and memory holds both drafts", async () => {
    const a = await conversation(false);
    const b = await conversation(true);
    expect(b.texts).toEqual(a.texts);
    expect(b.texts.some((t) => t.includes("🔁 You reported an A train delay"))).toBe(true);
    expect((await b.store.listMemory!({ chatId: "rider-9", kind: "episodic" })).length).toBe(2);
    expect((await a.store.listMemory!({ chatId: "rider-9" })).length).toBe(0);
  });
});

describe("GET /api/memory", () => {
  it("returns the recalled items for a complaint with score breakdowns, scoped to its resident", async () => {
    const store = createMemoryStore();
    const memory = await seed(store);
    const server = createApiServer({ store, tracer: createNoopTracer(), memory, orchestrator: {} as Orchestrator });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/memory?complaintId=cmp_now&limit=5`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { complaintId: string; query: string; items: ScoredMemory[] };
      expect(body.complaintId).toBe("cmp_now");
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.length).toBeLessThanOrEqual(5);
      expect(body.items.every((i) => i.chatId === null || i.chatId === "rider-1")).toBe(true); // never rider-2's items
      expect(body.items.map((i) => i.id)).toContain("mem_ready_cmp_mine");
      for (const i of body.items) {
        expect(i).not.toHaveProperty("embedding");
        expect(i.breakdown).toMatchObject({ weights: { relevance: 0.5, recency: 0.3, importance: 0.2 } });
        expect(i.score).toBeCloseTo(0.5 * i.breakdown.relevance + 0.3 * i.breakdown.recency + 0.2 * i.breakdown.importance, 3);
      }
      const sorted = [...body.items].sort((x, y) => y.score - x.score);
      expect(body.items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
      expect((await fetch(`${base}/api/memory?complaintId=nope`)).status).toBe(404);
      const all = (await (await fetch(`${base}/api/memory?kind=procedural`)).json()) as { items: ScoredMemory[] };
      expect(all.items.map((i) => i.kind)).toEqual(["procedural"]);
    } finally {
      server.close();
    }
  });
});
