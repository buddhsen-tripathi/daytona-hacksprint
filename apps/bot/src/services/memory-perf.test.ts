/**
 * #22: the approval card never waits for recall; recall runs afterwards (trace + /api/memory cache).
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClassificationResult, Embedder, MemoryRecord, Store } from "../core/contracts.js";
import { EMPTY_LOCATION } from "../core/contracts.js";
import { createOrchestrator, type Orchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { HNSW_DIM, createSurrealStore, type SurrealStore } from "../integrations/surrealdb.js";
import { KEYWORD_RELEVANCE_SCALE, createAgentMemory, keywordJaccard, keywordRelevance, mergeMemoryPool, scoreMemory, tokenize, type AgentMemoryService } from "./agent-memory.js";

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

function orchestrator(store: Store, memory: AgentMemoryService) {
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
  return { orch, transport };
}

describe("#22 approval card does not wait for recall", () => {
  it("an embedder that never resolves: the card is still sent within 200 ms", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const hanging: Embedder = { model: "test/hang", dim: 8, embed: () => (calls++, new Promise(() => {})) };
    const memory = createAgentMemory({ store, embedder: hanging });
    const { orch, transport } = orchestrator(store, memory);
    const t0 = Date.now();
    await orch.handle({ kind: "text", chatId: "rider-1", updateId: "u1", text: "The A train sat at 14 St for 25 minutes, downtown", username: null });
    const ms = Date.now() - t0;
    const card = transport.messages.find((m) => m.buttons?.flat().some((b) => /approve/i.test(b.text)));
    expect(card, transport.messages.map((m) => m.text).join("\n---\n")).toBeTruthy();
    expect(ms).toBeLessThan(200);
    expect(calls).toBeGreaterThan(0); // remember + recall did start embedding, in the background
  });

  it("recall runs after the card: one shared embedding, cached for GET /api/memory (cached: true)", async () => {
    const store = createMemoryStore();
    const hash = createHashEmbedder();
    let calls = 0;
    const counting: Embedder = { model: hash.model, dim: hash.dim, embed: (t) => (calls++, hash.embed(t)) };
    const memory = createAgentMemory({ store, embedder: counting });
    const { orch } = orchestrator(store, memory);
    await orch.handle({ kind: "text", chatId: "rider-1", updateId: "u1", text: "The A train sat at 14 St for 25 minutes, downtown", username: null });
    await memory.flush();
    const [c] = await store.listComplaints({ limit: 5 });
    expect(c?.status).toBe("READY_FOR_APPROVAL");
    // the ready-for-approval write and the background recall share one embedding of the same text
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    const cached = memory.cachedRecall(c!.id, c!.draftVersion);
    expect(cached?.items.map((i) => i.id)).toContain(`mem_ready_${c!.id}`);

    const server = createApiServer({ store, tracer: createNoopTracer(), memory, orchestrator: {} as Orchestrator });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const hit = (await (await fetch(`${base}/api/memory?complaintId=${c!.id}&limit=5`)).json()) as { cached: boolean; items: unknown[] };
      expect(hit.cached).toBe(true);
      expect(hit.items.length).toBeLessThanOrEqual(5);
      const miss = (await (await fetch(`${base}/api/memory?complaintId=${c!.id}&limit=50`)).json()) as { cached: boolean };
      expect(miss.cached).toBe(false);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// vector-index recall on the embedded engine (5,000 items)
// ---------------------------------------------------------------------------
const MODEL = "openai/text-embedding-3-small";
const N = 5000;
/** Deterministic pseudo-random unit vectors (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function unit(r: () => number, dim = HNSW_DIM): number[] {
  const v = Array.from({ length: dim }, () => r() - 0.5);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

describe("#22 recall over the HNSW index (SurrealDB embedded, 5,000 items)", () => {
  let store: SurrealStore;
  const vectors: number[][] = [];
  const r = rng(22);
  const t0 = Date.parse("2026-10-16T12:00:00.000Z");
  beforeAll(async () => {
    store = createSurrealStore({ url: "mem://", isolated: true });
    await store.init();
    const rows: MemoryRecord[] = [];
    for (let i = 0; i < N; i++) {
      const v = unit(r);
      vectors.push(v);
      rows.push({ id: `mem_p${i}`, kind: i % 3 ? "episodic" : "semantic", text: `report ${i} about the ${i % 2 ? "A" : "F"} train`, category: "subway-delay", chatId: i % 10 === 0 ? null : `rider-${i % 50}`, line: i % 2 ? "A" : "F", geo: null, importance: 0.5, data: {}, source: `complaint:cmp_p${i}`, about: [], createdAt: new Date(t0 - (N - i) * 60_000).toISOString(), embedding: v, embedModel: MODEL });
    }
    // fallback-embedded rows (OpenRouter was down): invisible to the index, must still be candidates
    for (let i = 0; i < 20; i++) rows.push({ id: `mem_fb${i}`, kind: "episodic", text: `fallback report ${i} A train held at 14 St`, category: "subway-delay", chatId: "rider-7", line: "A", geo: null, importance: 0.5, data: {}, source: `complaint:cmp_fb${i}`, about: [], createdAt: new Date(t0 - i * 1000).toISOString(), embedding: unit(r, 256), embedModel: "local/hash-bow-256" });
    for (let i = 0; i < rows.length; i += 200) await Promise.all(rows.slice(i, i + 200).map((row) => store.insertMemory!(row)));
  }, 120_000);
  afterAll(async () => store?.close());

  const near = (i: number) => vectors[i]!.map((x, j) => x + (j % 7 === 0 ? 0.002 : 0));
  const embedderFor = (v: number[]): Embedder => ({ model: MODEL, dim: HNSW_DIM, embed: async (t) => ({ model: MODEL, vectors: t.map(() => v) }) });

  it("finds the nearest item (unscoped and resident-scoped), keeps fallback rows as candidates", async () => {
    const hits = await store.searchMemory!({ embedding: near(1234), embedModel: MODEL, limit: 64 });
    expect(hits[0]?.id).toBe("mem_p1234");
    expect(hits[0]!.similarity!).toBeGreaterThan(0.99);
    const scoped = await store.searchMemory!({ embedding: near(1237), embedModel: MODEL, chatId: "rider-37", kind: "episodic", limit: 64 });
    expect(scoped[0]?.id).toBe("mem_p1237");
    expect(scoped.every((h) => h.chatId === null || h.chatId === "rider-37")).toBe(true);
    expect(scoped.every((h) => h.kind === "episodic")).toBe(true);
    const r7 = await store.searchMemory!({ embedding: near(7), embedModel: MODEL, chatId: "rider-7", line: "A", limit: 64 });
    expect(r7.some((h) => h.id.startsWith("mem_fb") && h.similarity === null)).toBe(true);
    expect(r7.filter((h) => h.similarity != null).every((h) => h.embedModel === MODEL)).toBe(true);
  });

  it("fallback rows keep ⌈pool/4⌉ slots in a full unscoped pool; re-embedding moves them into the index", async () => {
    const pool = await store.searchMemory!({ embedding: near(42), embedModel: MODEL, limit: 64 });
    expect(pool).toHaveLength(64);
    expect(pool[0]?.id).toBe("mem_p42");
    expect(pool.filter((h) => h.id.startsWith("mem_fb")).length).toBe(16);
    const todo = await store.listMemoryNeedingEmbedding!({ model: MODEL, limit: 100 });
    expect(todo.map((t) => t.id).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `mem_fb${i}`).sort());
    const v = unit(rng(7));
    await store.setMemoryEmbedding!("mem_fb3", v, MODEL);
    const hits = await store.searchMemory!({ embedding: v, embedModel: MODEL, limit: 8 });
    expect(hits[0]).toMatchObject({ id: "mem_fb3", embedModel: MODEL });
    expect(hits[0]!.similarity!).toBeGreaterThan(0.99);
    expect((await store.listMemoryNeedingEmbedding!({ model: MODEL, limit: 100 })).length).toBe(19);
  });

  it("recall() < 300 ms (KNN over the index)", async (ctx) => {
    if (!store.knnRecall) ctx.skip(); // engine without HNSW/KNN: correctness above still ran on the scan
    const memory = createAgentMemory({ store, embedder: embedderFor(near(4321)), now: () => t0 });
    await memory.recall({ text: "warm-up", limit: 10 });
    const timings: number[] = [];
    for (const scope of [{}, { chatId: "rider-21" }, { chatId: "rider-21", category: "subway-delay", line: "A" }]) {
      const s = performance.now();
      const got = await memory.recall({ text: "A train delay", scope, limit: 10 });
      timings.push(performance.now() - s);
      expect(got.length).toBeGreaterThan(0);
      if (!Object.keys(scope).length) expect(got[0]?.id).toBe("mem_p4321");
    }
    console.log(`[perf] recall over ${N} items (unscoped / resident / resident+line): ${timings.map((t) => `${t.toFixed(0)} ms`).join(" / ")}`);
    for (const t of timings) expect(t).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// score normalisation + lazy re-embedding
// ---------------------------------------------------------------------------
describe("#22 keyword and cosine relevance are on one scale", () => {
  it("keyword relevance = 0.6 × Jaccard", () => {
    expect(keywordJaccard(tokenize("train delay"), "train delay")).toBe(1);
    expect(keywordRelevance(tokenize("train delay"), "train delay")).toBe(KEYWORD_RELEVANCE_SCALE);
    // query terms fully contained in a long doc no longer score 1.0
    expect(keywordRelevance(tokenize("A train delay"), "Subway delay on the A train downtown near 14 St, held 25 minutes")).toBeCloseTo(0.6 * (3 / 11), 5);
  });

  it("a typical good cosine match (0.6) outranks a keyword-only row that contains every query term", () => {
    const at = new Date().toISOString();
    const base = { kind: "episodic" as const, category: null, chatId: null, line: null, geo: null, importance: 0.5, data: {}, source: "seed", about: [], createdAt: at, embedModel: MODEL };
    const tokens = tokenize("A train delay");
    const cos = scoreMemory({ ...base, id: "cos", text: "the uptown express was held for twenty minutes", similarity: 0.6 }, tokens, Date.now());
    const kw = scoreMemory({ ...base, id: "kw", text: "Subway delay on the A train downtown near 14 St, held 25 minutes", embedModel: "local/hash-bow-256", similarity: null }, tokens, Date.now());
    expect(kw.breakdown.relevanceKind).toBe("keyword");
    expect(cos.score).toBeGreaterThan(kw.score);
  });

  it("mergeMemoryPool keeps ⌈limit/4⌉ slots for rows without a comparable vector, gives unused slots back", () => {
    const at = (i: number) => new Date(Date.parse("2026-10-16T12:00:00.000Z") - i * 1000).toISOString();
    const hit = (id: string, similarity: number | null, i: number) => ({ id, similarity, createdAt: at(i), kind: "episodic", text: id, category: null, chatId: null, line: null, geo: null, importance: 0.5, data: {}, source: "s", about: [], embedModel: null }) as never;
    const sim = Array.from({ length: 100 }, (_, i) => hit(`s${i}`, 1 - i / 100, i));
    const other = Array.from({ length: 10 }, (_, i) => hit(`o${i}`, null, i));
    const got = mergeMemoryPool(sim, other, 20);
    expect(got.map((h: { id: string }) => h.id)).toEqual([...Array.from({ length: 15 }, (_, i) => `s${i}`), ...Array.from({ length: 5 }, (_, i) => `o${i}`)]);
    expect(mergeMemoryPool(sim.slice(0, 3), other, 8).map((h: { id: string }) => h.id)).toEqual(["s0", "s1", "s2", "o0", "o1", "o2", "o3", "o4"]);
    expect(mergeMemoryPool(sim, other.slice(0, 1), 8)).toHaveLength(8);
  });
});

describe("#22 reembedFallbackItems", () => {
  it("re-embeds fallback rows once the real embedder answers; stops while it is still on the fallback", async () => {
    const store = createMemoryStore();
    const offline = createAgentMemory({ store, embedder: createHashEmbedder() });
    await offline.remember({ id: "mem_old1", kind: "episodic", text: "A train held at 14 St", source: "complaint:c1" });
    await offline.remember({ id: "mem_old2", kind: "episodic", text: "F train skipped Bergen St", source: "complaint:c2" });
    expect(await offline.reembedFallbackItems()).toBe(0); // the local embedder has nothing better

    let down = true;
    const hash = createHashEmbedder(16);
    const real: Embedder = { model: "fake/real-16", dim: 16, embed: async (t) => (down ? createHashEmbedder().embed(t) : { model: "fake/real-16", vectors: (await hash.embed(t)).vectors }) };
    let clock = Date.now();
    const online = createAgentMemory({ store, embedder: real, now: () => clock });
    expect(await online.reembedFallbackItems()).toBe(0); // embedder still answers with its fallback model
    down = false;
    clock += 31_000; // past REEMBED_MIN_GAP_MS since the attempt above
    // a recall that meets fallback rows schedules the re-embedding in the background
    const before = await online.recall({ text: "A train held", limit: 5 });
    expect(before.every((m) => m.breakdown.relevanceKind === "keyword")).toBe(true);
    await online.flush();
    expect(await store.listMemoryNeedingEmbedding!({ model: real.model, limit: 10 })).toEqual([]);
    const after = await online.recall({ text: "A train held", limit: 5 });
    expect(after[0]).toMatchObject({ id: "mem_old1", embedModel: real.model, breakdown: { relevanceKind: "cosine" } });
  });
});
