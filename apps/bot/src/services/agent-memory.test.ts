import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Embedder, FilingAttempt, Store } from "../core/contracts.js";
import { nowIso } from "../core/contracts.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createSurrealStore, type SurrealStore } from "../integrations/surrealdb.js";
import { MEMORY_WEIGHTS, createAgentMemory, keywordOverlap, recencyDecay, scrubPii, tokenize } from "./agent-memory.js";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3600_000).toISOString();

function attempt(id: string, complaintId: string): FilingAttempt {
  return {
    id,
    complaintId,
    approvedVersion: 1,
    target: "real",
    category: "subway-delay",
    sandboxId: null,
    sandboxProvider: "local",
    browserSessionId: null,
    browserProvider: "local",
    liveViewUrl: null,
    recordingUrl: null,
    outcome: "HUMAN_ACTION_REQUIRED",
    errorCode: "UNEXPECTED_REQUIRED_FIELD",
    officialRequestNumber: null,
    verified: false,
    verificationNotes: null,
    evidence: [],
    workerEvents: [],
    traceId: null,
    traceUrl: null,
    timing: { sandboxMs: null, browserMs: null, workerMs: null, totalMs: null },
    createdAt: nowIso(),
    finishedAt: nowIso(),
  };
}

type Ctx = { store: Store; extraRelationCheck?: (memoryId: string, attemptId: string) => Promise<boolean> };

function suite(name: string, make: () => Promise<Ctx & { close?: () => Promise<void> }>, embedder: Embedder | null = null) {
  describe(`agent memory (${name})`, () => {
    let ctx: Ctx & { close?: () => Promise<void> };
    beforeAll(async () => {
      ctx = await make();
    }, 30_000);
    afterAll(async () => {
      await ctx?.close?.();
    });
    const mem = () => createAgentMemory({ store: ctx.store, embedder, now: () => NOW });

    it("remember → recall returns it first, with a breakdown that sums to the score", async () => {
      const m = mem();
      await m.remember({ id: "mem_a1", kind: "episodic", text: "Subway delay on the A train downtown near 14 St, held 25 minutes", category: "subway-delay", chatId: "rider-1", line: "A", importance: 0.5, source: "complaint:cmp_1", createdAt: daysAgo(1) });
      await m.remember({ id: "mem_a2", kind: "episodic", text: "Elevator out of service at Union Square", category: "subway-delay", chatId: "rider-1", importance: 0.5, source: "complaint:cmp_2", createdAt: daysAgo(1) });
      const got = await m.recall({ text: "A train held downtown at 14 St", scope: { chatId: "rider-1" }, limit: 5 });
      expect(got[0]?.id).toBe("mem_a1");
      const b = got[0]!.breakdown;
      expect(b.relevanceKind).toBe(embedder ? "cosine" : "keyword");
      expect(b.relevance).toBeGreaterThan(got.find((g) => g.id === "mem_a2")?.breakdown.relevance ?? 0);
      expect(got[0]!.score).toBeCloseTo(MEMORY_WEIGHTS.relevance * b.relevance + MEMORY_WEIGHTS.recency * b.recency + MEMORY_WEIGHTS.importance * b.importance, 3);
      expect(got[0]).not.toHaveProperty("embedding");
    });

    it("recency decay orders otherwise-equal items newest first (half-life 7 days)", async () => {
      const m = mem();
      const base = { kind: "semantic" as const, text: "MTA customer feedback form needs the line and direction", category: "recency-test", importance: 0.4, source: "seed" };
      await m.remember({ ...base, id: "mem_r_old", createdAt: daysAgo(14) });
      await m.remember({ ...base, id: "mem_r_new", createdAt: daysAgo(0) });
      await m.remember({ ...base, id: "mem_r_mid", createdAt: daysAgo(7) });
      const got = await m.recall({ text: "line and direction", scope: { category: "recency-test" } });
      expect(got.map((g) => g.id)).toEqual(["mem_r_new", "mem_r_mid", "mem_r_old"]);
      expect(got[1]!.breakdown.recency).toBeCloseTo(0.5, 3);
      expect(got[2]!.breakdown.recency).toBeCloseTo(0.25, 3);
      // no query text: relevance contributes nothing, recency + importance still rank
      const noText = await m.recall({ scope: { category: "recency-test" } });
      expect(noText.map((g) => g.id)).toEqual(["mem_r_new", "mem_r_mid", "mem_r_old"]);
      expect(noText[0]!.breakdown.relevanceKind).toBe("none");
    });

    it("scope.chatId never returns other residents' items (world facts still come back)", async () => {
      const m = mem();
      await m.remember({ id: "mem_p_mine", kind: "episodic", text: "L train delay at Bedford Av", category: "privacy-test", chatId: "rider-7", source: "complaint:cmp_7" });
      await m.remember({ id: "mem_p_other", kind: "episodic", text: "L train delay at Bedford Av", category: "privacy-test", chatId: "rider-8", importance: 1, source: "complaint:cmp_8" });
      await m.remember({ id: "mem_p_world", kind: "semantic", text: "L train delays go to the MTA customer feedback form", category: "privacy-test", chatId: null, source: "seed" });
      const mine = await m.recall({ text: "L train delay Bedford", scope: { chatId: "rider-7", category: "privacy-test" }, limit: 50 });
      expect(mine.map((g) => g.id).sort()).toEqual(["mem_p_mine", "mem_p_world"]);
      expect(mine.every((g) => g.chatId === null || g.chatId === "rider-7")).toBe(true);
      // without a resident scope the stream is cross-resident (for counting duplicates, #5)
      const all = await m.recall({ text: "L train delay Bedford", scope: { category: "privacy-test" }, limit: 50 });
      expect(all.map((g) => g.id)).toContain("mem_p_other");
      // kind filter
      expect((await m.recall({ kind: "semantic", scope: { category: "privacy-test" } })).map((g) => g.id)).toEqual(["mem_p_world"]);
    });

    it("sinceMs, line and geo scopes filter structurally", async () => {
      const m = mem();
      await m.remember({ id: "mem_s_old", kind: "episodic", text: "7 train delay", category: "scope-test", line: "7", createdAt: daysAgo(3), source: "seed" });
      await m.remember({ id: "mem_s_new", kind: "episodic", text: "7 train delay", category: "scope-test", line: "7", createdAt: daysAgo(0), source: "seed" });
      await m.remember({ id: "mem_s_g", kind: "episodic", text: "G train delay", category: "scope-test", line: "G", geo: { lat: 40.7359, lon: -73.9911 }, source: "seed" });
      expect((await m.recall({ scope: { category: "scope-test" }, sinceMs: 24 * 3600_000 })).map((g) => g.id).sort()).toEqual(["mem_s_g", "mem_s_new"]);
      expect((await m.recall({ scope: { category: "scope-test", line: "7" } })).map((g) => g.id)).toEqual(["mem_s_new", "mem_s_old"]);
      expect((await m.recall({ scope: { category: "scope-test", geo: { lat: 40.736, lon: -73.9912, radiusMeters: 50 } } })).map((g) => g.id)).toEqual(["mem_s_g"]);
      expect((await m.recall({ scope: { category: "scope-test", geo: { lat: 40.7386, lon: -73.9911, radiusMeters: 50 } } })).length).toBe(0);
    });

    it("remember upserts by id and scrubs PII from text", async () => {
      const m = mem();
      await m.remember({ id: "mem_u", kind: "episodic", text: "first version", category: "upsert-test", source: "seed" });
      await m.remember({ id: "mem_u", kind: "episodic", text: "second version, reach me at jane@example.com or 212-555-0100", category: "upsert-test", source: "seed" });
      const got = await m.recall({ scope: { category: "upsert-test" } });
      expect(got).toHaveLength(1);
      expect(got[0]!.text).toBe("second version, reach me at [email] or [phone]");
    });

    it("reflect writes an episodic lesson about the filing attempt (memory->about->filing_attempt)", async () => {
      await ctx.store.createAttempt(attempt("att_reflect", "cmp_reflect"));
      const m = mem();
      await m.reflect("att_reflect", "The MTA form asked for the car number; ask before approval next time.", { field: "car_number" });
      await m.flush();
      const rows = await ctx.store.listMemory!({ about: { table: "filing_attempt", id: "att_reflect" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "episodic", source: "attempt:att_reflect", category: "subway-delay", data: { field: "car_number", reflection: true, errorCode: "UNEXPECTED_REQUIRED_FIELD" } });
      expect(rows[0]!.about).toContainEqual({ table: "filing_attempt", id: "att_reflect" });
      const recalled = await m.recall({ text: "car number", about: { table: "filing_attempt", id: "att_reflect" } });
      expect(recalled[0]?.source).toBe("attempt:att_reflect");
      if (ctx.extraRelationCheck) expect(await ctx.extraRelationCheck(rows[0]!.id, "att_reflect")).toBe(true);
    });
  });
}

suite("SurrealDB embedded", async () => {
  const store: SurrealStore = createSurrealStore({ url: "mem://", isolated: true });
  await store.init();
  return {
    store,
    close: () => store.close(),
    extraRelationCheck: async (memoryId, attemptId) => {
      const [rows] = await store.query<[unknown[]]>("SELECT VALUE out FROM about WHERE in = type::record('memory', $m) AND out = type::record('filing_attempt', $a)", { m: memoryId, a: attemptId });
      return rows.length === 1;
    },
  };
});
suite("memory store", async () => ({ store: createMemoryStore() }));
suite("SurrealDB embedded + hashed embeddings", async () => {
  const store = createSurrealStore({ url: "mem://", isolated: true });
  await store.init();
  return { store, close: () => store.close() };
}, createHashEmbedder());
suite("memory store + hashed embeddings", async () => ({ store: createMemoryStore() }), createHashEmbedder());

describe("agent memory: vectors across models (SurrealDB embedded)", () => {
  let store: SurrealStore;
  beforeAll(async () => {
    store = createSurrealStore({ url: "mem://", isolated: true });
    await store.init();
  }, 30_000);
  afterAll(async () => {
    await store?.close();
  });

  it("defines the HNSW index and stores 1536-dim vectors; cosine is computed in SurrealQL", async () => {
    expect(store.vectorIndex).toBe(true);
    const unit = (i: number) => Array.from({ length: 1536 }, (_, j) => (j === i ? 1 : 0));
    const fake1536: Embedder = { model: "fake/1536", dim: 1536, embed: async (texts) => ({ model: "fake/1536", vectors: texts.map((t) => unit(t.includes("delay") ? 0 : 1)) }) };
    const m = createAgentMemory({ store, embedder: fake1536, now: () => NOW });
    await m.remember({ id: "mem_v_delay", kind: "episodic", text: "train delay", category: "vec", source: "seed", createdAt: daysAgo(0) });
    await m.remember({ id: "mem_v_other", kind: "episodic", text: "broken elevator", category: "vec", source: "seed", createdAt: daysAgo(0) });
    const got = await m.recall({ text: "delay again", scope: { category: "vec" } });
    expect(got.map((g) => [g.id, g.breakdown.relevanceKind, g.breakdown.relevance])).toEqual([
      ["mem_v_delay", "cosine", 1],
      ["mem_v_other", "cosine", 0],
    ]);
    const [knn] = await store.query<[{ id: unknown }[]]>("SELECT id FROM memory WHERE embedding_1536 <|1,40|> $q", { q: unit(0) });
    expect(knn.map((r) => String(r.id))).toEqual(["memory:mem_v_delay"]);

    // a query embedded by another model never compares vectors across models: keyword overlap instead
    const hash = createAgentMemory({ store, embedder: createHashEmbedder(), now: () => NOW });
    const mixed = await hash.recall({ text: "train delay", scope: { category: "vec" } });
    expect(mixed[0]).toMatchObject({ id: "mem_v_delay", breakdown: { relevanceKind: "keyword", relevance: 1 } });
  });
});

describe("agent memory: pure helpers", () => {
  it("tokenize keeps subway lines, drops stopwords, strips plurals", () => {
    expect(tokenize("The A train was held at 14 St for 25 minutes")).toEqual(["a", "train", "held", "14", "st", "25", "minute"]);
  });
  it("keyword overlap is the share of query terms found", () => {
    expect(keywordOverlap(tokenize("A train delay"), "Subway delay on the A train")).toBe(1);
    expect(keywordOverlap(tokenize("A train elevator"), "Subway delay on the A train")).toBeCloseTo(2 / 3, 5);
    expect(keywordOverlap([], "anything")).toBe(0);
  });
  it("recency decays by half every 7 days", () => {
    expect(recencyDecay(0)).toBe(1);
    expect(recencyDecay(7 * 24 * 3600_000)).toBeCloseTo(0.5, 6);
  });
  it("scrubPii removes emails and phone numbers", () => {
    expect(scrubPii("mail a.b@c.io, call (718) 555-0199")).toBe("mail [email], call [phone]");
  });
});
