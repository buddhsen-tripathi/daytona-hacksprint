/**
 * Embedders for agent memory (#4).
 *
 * - OpenRouter (`openai/text-embedding-3-small`, 1536 dims) when OPENROUTER_API_KEY is set,
 *   cached by text hash in memory + on disk (.runs/embed-cache/).
 * - Deterministic fallback: hashed bag-of-words into 256 dims, L2-normalised. Used when there
 *   is no key, and per call when OpenRouter fails (then a 60 s cool-down skips the network).
 *   Vectors are labelled with the model that produced them, so the store only ever compares
 *   vectors of one model (a fallback query against OpenRouter items degrades to keyword overlap).
 */
import { resolve } from "node:path";
import type { Embedder } from "../core/contracts.js";
import { tokenize } from "../services/agent-memory.js";
import { REPO_ROOT, env } from "./env.js";
import { DEFAULT_EMBED_MODEL, embed } from "./openrouter.js";

export const HASH_EMBED_DIM = 256;
export const OPENROUTER_EMBED_DIMS: Record<string, number> = { "openai/text-embedding-3-small": 1536, "openai/text-embedding-3-large": 3072, "openai/text-embedding-ada-002": 1536 };
const COOLDOWN_MS = 60_000;

/** FNV-1a 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashEmbed(text: string, dim = HASH_EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  const toks = tokenize(text);
  const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
  for (const f of feats) {
    const h = fnv1a(f);
    // signed hashing trick: the sign bit comes from a second hash so collisions cancel instead of pile up
    v[h % dim]! += (fnv1a(`#${f}`) & 1 ? 1 : -1) * (f.includes("_") ? 0.5 : 1);
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (!norm) {
    v[0] = 1; // empty text: a fixed unit vector (cosine stays defined)
    return v;
  }
  return v.map((x) => x / norm);
}

export function createHashEmbedder(dim = HASH_EMBED_DIM): Embedder {
  const model = `local/hash-bow-${dim}`;
  return {
    model,
    dim,
    async embed(texts) {
      return { model, vectors: texts.map((t) => hashEmbed(t, dim)) };
    },
  };
}

export type OpenRouterEmbedderOptions = { apiKey?: string; model?: string; cacheDir?: string | null; timeoutMs?: number; fallback?: Embedder };

export function createOpenRouterEmbedder(opts: OpenRouterEmbedderOptions = {}): Embedder & { lastError(): string | null } {
  const model = opts.model ?? (env.OPENROUTER_EMBED_MODEL || DEFAULT_EMBED_MODEL);
  const fallback = opts.fallback ?? createHashEmbedder();
  let dim = OPENROUTER_EMBED_DIMS[model] ?? 0;
  let downUntil = 0;
  let lastError: string | null = null;
  return {
    model,
    get dim() {
      return dim;
    },
    lastError: () => lastError,
    async embed(texts) {
      if (Date.now() < downUntil) return fallback.embed(texts);
      try {
        const vectors = await embed(texts, { model, apiKey: opts.apiKey, cacheDir: opts.cacheDir, timeoutMs: opts.timeoutMs });
        if (vectors[0]?.length) dim = vectors[0].length;
        lastError = null;
        return { model, vectors };
      } catch (err) {
        lastError = (err as Error).message;
        downUntil = Date.now() + COOLDOWN_MS;
        console.warn(`[memory] OpenRouter embeddings unavailable (${lastError.slice(0, 160)}); using ${fallback.model} for ${COOLDOWN_MS / 1000} s`);
        return fallback.embed(texts);
      }
    },
  };
}

/** OpenRouter when a key is configured, else the local hashed embedder. */
export function createEmbedder(): Embedder {
  if (!env.OPENROUTER_API_KEY) return createHashEmbedder();
  const dir = env.OPENROUTER_EMBED_CACHE_DIR;
  const cacheDir = /^(off|none|false|0)$/i.test(dir) ? null : resolve(REPO_ROOT, dir);
  return createOpenRouterEmbedder({ apiKey: env.OPENROUTER_API_KEY, cacheDir });
}
