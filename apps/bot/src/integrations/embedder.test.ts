import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cosineSimilarity } from "../services/agent-memory.js";
import { HASH_EMBED_DIM, createHashEmbedder, createOpenRouterEmbedder, hashEmbed } from "./embedder.js";
import { OPENROUTER_EMBED_URL, OpenRouterError, __clearEmbedCacheForTests, embed, embedCacheKey, validCachedVector } from "./openrouter.js";

const vec = (seed: number, dim = 4) => Array.from({ length: dim }, (_, i) => seed + i / 10);
/** Fake /embeddings: returns rows in REVERSE order (index field must be honoured). */
function fakeEmbeddings(calls: string[][]) {
  return vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(OPENROUTER_EMBED_URL);
    const body = JSON.parse(String(init.body)) as { model: string; input: string[] };
    calls.push(body.input);
    const data = body.input.map((t, index) => ({ object: "embedding", index, embedding: vec(t.length) })).reverse();
    return new Response(JSON.stringify({ model: body.model, data, usage: { prompt_tokens: 1 } }), { status: 200 });
  });
}

beforeEach(() => __clearEmbedCacheForTests());
afterEach(() => vi.unstubAllGlobals());

describe("hashed bag-of-words fallback embedder", () => {
  it("is deterministic, 256-dim and L2-normalised", async () => {
    const e = createHashEmbedder();
    const { model, vectors } = await e.embed(["A train held at 14 St", "A train held at 14 St", ""]);
    expect(model).toBe(`local/hash-bow-${HASH_EMBED_DIM}`);
    expect(vectors[0]).toHaveLength(HASH_EMBED_DIM);
    expect(vectors[0]).toEqual(vectors[1]);
    expect(Math.hypot(...vectors[0]!)).toBeCloseTo(1, 6);
    expect(Math.hypot(...vectors[2]!)).toBeCloseTo(1, 6); // empty text still a unit vector
  });
  it("puts related texts closer than unrelated ones", () => {
    const q = hashEmbed("A train delay downtown");
    expect(cosineSimilarity(q, hashEmbed("Subway delay: the A train downtown was held"))!).toBeGreaterThan(cosineSimilarity(q, hashEmbed("Elevator broken at Union Square"))!);
  });
});

describe("openrouter embed()", () => {
  it("batches ≤ 64, preserves order by index, de-duplicates and caches by text hash", async () => {
    const calls: string[][] = [];
    vi.stubGlobal("fetch", fakeEmbeddings(calls));
    const texts = Array.from({ length: 70 }, (_, i) => "x".repeat(i + 1));
    const out = await embed([...texts, texts[0]!], { apiKey: "k", model: "m" });
    expect(calls.map((c) => c.length)).toEqual([64, 6]);
    expect(out).toHaveLength(71);
    expect(out[0]).toEqual(vec(1));
    expect(out[69]).toEqual(vec(70));
    expect(out[70]).toEqual(out[0]);
    await embed([texts[5]!], { apiKey: "k", model: "m" });
    expect(calls).toHaveLength(2); // in-memory cache hit
    await embed([texts[5]!], { apiKey: "k", model: "other" });
    expect(calls).toHaveLength(3); // cache key includes the model
  });

  it("persists to the on-disk cache when cacheDir is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    try {
      const calls: string[][] = [];
      vi.stubGlobal("fetch", fakeEmbeddings(calls));
      await embed(["hello"], { apiKey: "k", model: "m", cacheDir: dir });
      await new Promise((r) => setTimeout(r, 20));
      expect(readdirSync(dir)).toHaveLength(1);
      __clearEmbedCacheForTests();
      expect(await embed(["hello"], { apiKey: "k", model: "m", cacheDir: dir })).toEqual([vec(5)]);
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats empty / corrupt / wrong-dimension cache files as misses and deletes them (#24)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    try {
      const calls: string[][] = [];
      vi.stubGlobal("fetch", fakeEmbeddings(calls));
      const bad: Record<string, string> = { empty: "", blank: "[]", trunc: "[0.1, 0.2", junk: "{\"a\":1}", nan: "[0.1, \"x\", 0.3, 0.4]", short: "[0.1, 0.2]" };
      for (const [text, body] of Object.entries(bad)) writeFileSync(join(dir, `${embedCacheKey("m", text)}.json`), body);
      const texts = Object.keys(bad);
      const out = await embed(texts, { apiKey: "k", model: "m", cacheDir: dir, dim: 4 });
      expect(out).toEqual(texts.map((t) => vec(t.length)));
      expect(calls).toEqual([texts]); // every bad file was a miss
      await new Promise((r) => setTimeout(r, 30));
      // rewritten with valid vectors (no stray temp files)
      expect(readdirSync(dir).sort()).toEqual(texts.map((t) => `${embedCacheKey("m", t)}.json`).sort());
      for (const t of texts) expect(JSON.parse(readFileSync(join(dir, `${embedCacheKey("m", t)}.json`), "utf8"))).toEqual(vec(t.length));
      // a corrupt file is deleted even when the refetch fails
      __clearEmbedCacheForTests();
      writeFileSync(join(dir, `${embedCacheKey("m", "empty")}.json`), "");
      vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
      await expect(embed(["empty"], { apiKey: "k", model: "m", cacheDir: dir, dim: 4 })).rejects.toBeInstanceOf(OpenRouterError);
      expect(existsSync(join(dir, `${embedCacheKey("m", "empty")}.json`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validCachedVector: non-empty finite numbers of the expected length", () => {
    expect(validCachedVector([0.1, 0.2], 2)).toBe(true);
    expect(validCachedVector([0.1, 0.2])).toBe(true);
    expect(validCachedVector([], undefined)).toBe(false);
    expect(validCachedVector([0.1], 2)).toBe(false);
    expect(validCachedVector([0.1, null], 2)).toBe(false);
    expect(validCachedVector({ length: 2 }, 2)).toBe(false);
  });

  it("throws typed errors (missing key, HTTP)", async () => {
    await expect(embed(["a"], { apiKey: "", model: "m" })).rejects.toMatchObject({ kind: "missing_key" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(embed(["a"], { apiKey: "k", model: "m" })).rejects.toBeInstanceOf(OpenRouterError);
  });
});

describe("OpenRouter embedder with fallback", () => {
  it("labels vectors with the OpenRouter model, and falls back to the hashed embedder on error", async () => {
    const calls: string[][] = [];
    vi.stubGlobal("fetch", fakeEmbeddings(calls));
    const e = createOpenRouterEmbedder({ apiKey: "k", model: "openai/text-embedding-3-small" });
    expect(e.dim).toBe(1536);
    expect((await e.embed(["abc"])).model).toBe("openai/text-embedding-3-small");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await e.embed(["something new"]);
    expect(r.model).toBe(`local/hash-bow-${HASH_EMBED_DIM}`);
    expect(r.vectors[0]).toHaveLength(HASH_EMBED_DIM);
    expect(e.lastError()).toMatch(/HTTP 500/);
    warn.mockRestore();
  });
});
