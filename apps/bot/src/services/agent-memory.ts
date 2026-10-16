/**
 * Agent memory (issue #4, epic #3): one memory stream of episodic / semantic /
 * procedural items, recalled Generative-Agents style:
 *
 *   score = 0.5·relevance + 0.3·recency + 0.2·importance
 *
 *   relevance  cosine(query, item) when both have embeddings from the same model,
 *              else keyword overlap (share of query terms found in the item),
 *              0 when the query has no text
 *   recency    0.5^(age / 7 days)
 *   importance 0..1, set at write time
 *
 * The Store does structural filtering (kind, category, resident scope, line, geo,
 * time window, about-edge) and cosine similarity; ranking lives here so the
 * SurrealDB and in-memory stores rank identically. Every recalled item carries
 * its breakdown so the dashboard can explain *why* it was recalled.
 *
 * Privacy: `scope.chatId` ⇒ only that resident's items + world facts (chatId null).
 * `text` is neutral by construction (callers pass classifier descriptions, form
 * prompts and official labels); `scrubPii` is a last line of defence.
 */
import type {
  AgentMemory,
  CategoryDefinition,
  ComplaintDraft,
  Embedder,
  FilingAttempt,
  FilingErrorCode,
  FilingStatus,
  MemoryHit,
  MemoryItem,
  MemoryRecallQuery,
  MemoryRecord,
  MemorySearch,
  ScoredMemory,
  Store,
  Tracer,
  WorkerAnswer,
  WorkerQuestion,
  WorkflowPattern,
} from "../core/contracts.js";
import { CATEGORIES, haversineMeters, shortId } from "../core/contracts.js";
import { getCategory } from "../core/knowledge.js";

export const MEMORY_WEIGHTS = { relevance: 0.5, recency: 0.3, importance: 0.2 } as const;
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600_000;
export const DEFAULT_IMPORTANCE = 0.5;
export const MAX_MEMORY_TEXT = 2000;
const DEFAULT_GEO_RADIUS_M = 100;

// ---------------------------------------------------------------------------
// pure helpers (shared by both stores)
// ---------------------------------------------------------------------------
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Last line of defence: no emails / phone numbers in memory text. */
export function scrubPii(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MEMORY_TEXT);
}

const STOPWORDS = new Set(
  "a an and are as at be been but by for from had has have i in is it its me my of on or our so that the their them there they this to was were will with you your".split(" "),
);

/** Single-letter subway lines (uppercase in the source text, so the article "a" is still a stopword). */
const LINE_LETTERS = new Set("ABCDEFGJLMNQRSWZ".split(""));

/** Lowercase word tokens (≥ 2 chars, no stopwords, naive plural strip). Subway lines ("A", "7") are kept. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    if (raw.length === 1) {
      if (/^[0-9]$/.test(raw) || LINE_LETTERS.has(raw)) out.push(raw.toLowerCase());
      continue;
    }
    const t = raw.toLowerCase();
    if (STOPWORDS.has(t)) continue;
    out.push(t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
  }
  return out;
}

/** Share of distinct query terms present in the document (0..1). */
export function keywordOverlap(queryTokens: string[], docText: string): number {
  const q = new Set(queryTokens);
  if (!q.size) return 0;
  const d = new Set(tokenize(docText));
  let hit = 0;
  for (const t of q) if (d.has(t)) hit++;
  return hit / q.size;
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!a.length || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function recencyDecay(ageMs: number, halfLifeMs = RECENCY_HALF_LIFE_MS): number {
  return clamp01(0.5 ** (Math.max(0, ageMs) / halfLifeMs));
}

/** Reference filter (memory store) — same semantics as the SurrealQL WHERE in surrealdb.ts. */
export function memoryMatches(row: MemoryRecord, q: Omit<MemorySearch, "limit" | "embedding" | "embedModel">, nowMs = Date.now()): boolean {
  if (q.kind && row.kind !== q.kind) return false;
  if (q.category && row.category !== q.category) return false;
  if (q.chatId && row.chatId != null && row.chatId !== q.chatId) return false;
  if (q.line && row.line !== q.line) return false;
  if (q.geo) {
    if (!row.geo) return false;
    if (haversineMeters(q.geo.lat, q.geo.lon, row.geo.lat, row.geo.lon) > q.geo.radiusMeters) return false;
  }
  if (q.sinceMs != null && Date.parse(row.createdAt) < nowMs - q.sinceMs) return false;
  if (q.about && !row.about.some((a) => a.table === q.about!.table && a.id === q.about!.id)) return false;
  return true;
}

/** Reference search (memory store): filter, cosine within the same model, most similar first, else newest first. */
export function searchMemoryRows(rows: Iterable<MemoryRecord>, q: MemorySearch): MemoryHit[] {
  const hits: MemoryHit[] = [];
  for (const row of rows) {
    if (!memoryMatches(row, q, q.nowMs)) continue;
    const comparable = q.embedding && row.embedding && q.embedModel && row.embedModel === q.embedModel;
    const similarity = comparable ? cosineSimilarity(q.embedding!, row.embedding!) : null;
    const { embedding: _e, ...rest } = row;
    hits.push({ ...rest, similarity });
  }
  hits.sort((a, b) => (b.similarity ?? -2) - (a.similarity ?? -2) || b.createdAt.localeCompare(a.createdAt));
  return hits.slice(0, q.limit);
}

export function scoreMemory(hit: MemoryHit, queryTokens: string[] | null, nowMs: number): ScoredMemory {
  const ageMs = Math.max(0, nowMs - Date.parse(hit.createdAt));
  let relevance = 0;
  let relevanceKind: ScoredMemory["breakdown"]["relevanceKind"] = "none";
  if (hit.similarity != null) {
    relevance = clamp01(hit.similarity);
    relevanceKind = "cosine";
  } else if (queryTokens?.length) {
    relevance = keywordOverlap(queryTokens, hit.text);
    relevanceKind = "keyword";
  }
  const recency = recencyDecay(ageMs);
  const importance = clamp01(hit.importance);
  const score = MEMORY_WEIGHTS.relevance * relevance + MEMORY_WEIGHTS.recency * recency + MEMORY_WEIGHTS.importance * importance;
  const { similarity: _s, ...item } = hit;
  return {
    ...item,
    score: Math.round(score * 1e4) / 1e4,
    breakdown: { relevance: round4(relevance), relevanceKind, recency: round4(recency), importance, ageMs, weights: { ...MEMORY_WEIGHTS } },
  };
}
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------
export type AgentMemoryDeps = {
  store: Store;
  /** null ⇒ keyword-overlap relevance only. */
  embedder?: Embedder | null;
  /** Phoenix spans: `memory.remember` (TOOL), `memory.recall` (RETRIEVER, recalled items as documents). */
  tracer?: Tracer | null;
  /** Clock (tests). */
  now?: () => number;
};

export type AgentMemoryService = AgentMemory & { readonly embedder: Embedder | null };

export function createAgentMemory(deps: AgentMemoryDeps): AgentMemoryService {
  const { store } = deps;
  const embedder = deps.embedder ?? null;
  const now = deps.now ?? Date.now;
  const tracer = deps.tracer ?? null;
  const inflight = new Set<Promise<unknown>>();
  let warned = false;

  async function embedOne(text: string): Promise<{ vector: number[]; model: string } | null> {
    if (!embedder || !text) return null;
    try {
      const r = await embedder.embed([text]);
      const v = r.vectors[0];
      return v?.length ? { vector: v, model: r.model } : null;
    } catch (err) {
      console.warn("[memory] embedding failed:", (err as Error).message);
      return null;
    }
  }

  async function write(item: MemoryItem): Promise<string> {
    if (!tracer) return writeRow(item);
    return tracer.span("memory.remember", { "memory.kind": item.kind, "memory.source": item.source, "memory.category": item.category ?? "", "memory.importance": item.importance ?? DEFAULT_IMPORTANCE }, async (set, oi) => {
      oi.tool({ name: "memory.remember", description: "Write one item to the agent memory stream (embedded, scored at recall)", parameters: { kind: item.kind, category: item.category ?? null, importance: item.importance ?? DEFAULT_IMPORTANCE } });
      oi.input({ text: scrubPii(item.text), source: item.source, about: item.about ?? [] });
      const id = await writeRow(item, (model) => set("memory.embed_model", model ?? "none"));
      oi.output({ id });
      return id;
    });
  }

  async function writeRow(item: MemoryItem, onEmbed?: (model: string | null) => void): Promise<string> {
    const id = item.id ?? shortId("mem");
    if (!store.insertMemory) {
      if (!warned) console.warn(`[memory] store ${store.backend} has no insertMemory; memory is not persisted`);
      warned = true;
      return id;
    }
    const text = scrubPii(item.text);
    const emb = await embedOne(text);
    onEmbed?.(emb?.model ?? null);
    const row: MemoryRecord = {
      id,
      kind: item.kind,
      text,
      category: item.category ?? null,
      chatId: item.chatId ?? null,
      line: item.line ?? null,
      geo: item.geo ?? null,
      importance: clamp01(item.importance ?? DEFAULT_IMPORTANCE),
      data: item.data ?? {},
      source: item.source,
      about: item.about ?? [],
      createdAt: item.createdAt ?? new Date(now()).toISOString(),
      embedding: emb?.vector ?? null,
      embedModel: emb?.model ?? null,
    };
    await store.insertMemory(row);
    return id;
  }

  const memory: AgentMemoryService = {
    embedder,

    remember(item) {
      const p = write(item);
      inflight.add(p);
      void p.catch(() => {}).finally(() => inflight.delete(p));
      return p;
    },

    async recall(q: MemoryRecallQuery) {
      if (!tracer) return recallImpl(q);
      return tracer.span("memory.recall", { "memory.kind": q.kind ?? "", "memory.category": q.scope?.category ?? "", "memory.scoped_to_resident": !!q.scope?.chatId, "memory.limit": q.limit ?? 10 }, async (set, oi) => {
        oi.input({ text: q.text ? scrubPii(q.text) : null, kind: q.kind ?? null, scope: { ...q.scope, chatId: q.scope?.chatId ? "(resident)" : null }, sinceMs: q.sinceMs ?? null, about: q.about ?? null });
        const items = await recallImpl(q);
        set("memory.recalled", items.length);
        oi.retriever(items.map((m) => ({ id: m.id, content: m.text, score: m.score, metadata: { kind: m.kind, source: m.source, category: m.category, ...m.breakdown } })));
        return items;
      });
    },

    async reflect(attemptId, lesson, data) {
      const attempt = await store.getAttempt(attemptId).catch(() => null);
      const complaint = attempt ? await store.getComplaint(attempt.complaintId).catch(() => null) : null;
      await memory.remember({
        kind: "episodic",
        text: lesson,
        category: attempt?.category ?? null,
        chatId: complaint?.telegramChatId ?? null,
        line: complaint?.transit?.line ?? null,
        importance: 0.7,
        data: { ...(data ?? {}), reflection: true, outcome: attempt?.outcome ?? null, errorCode: attempt?.errorCode ?? null },
        source: `attempt:${attemptId}`,
        about: [{ table: "filing_attempt", id: attemptId }, ...(attempt ? [{ table: "complaint" as const, id: attempt.complaintId }] : [])],
      });
    },

    async flush() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };

  async function recallImpl(q: MemoryRecallQuery): Promise<ScoredMemory[]> {
    if (!store.searchMemory) return [];
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 10)));
    const text = q.text?.trim() ? scrubPii(q.text) : "";
    const emb = text ? await embedOne(text) : null;
    const scope = q.scope ?? {};
    const nowMs = now();
    const hits = await store.searchMemory({
      embedding: emb?.vector ?? null,
      embedModel: emb?.model ?? null,
      kind: q.kind,
      category: scope.category ?? null,
      chatId: scope.chatId ?? null,
      line: scope.line ?? null,
      geo: scope.geo ? { lat: scope.geo.lat, lon: scope.geo.lon, radiusMeters: scope.geo.radiusMeters ?? DEFAULT_GEO_RADIUS_M } : null,
      sinceMs: q.sinceMs,
      about: q.about ?? null,
      nowMs,
      // candidate pool: ranking needs more than `limit` rows (a recent, important item may be less similar)
      limit: Math.max(limit * 8, 64),
    });
    const tokens = text ? tokenize(text) : null;
    return hits
      .map((h) => scoreMemory(h, tokens, nowMs))
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  return memory;
}


// ---------------------------------------------------------------------------
// write points (issue #4): the ONLY place memory text is composed, so the
// PII rule is reviewable in one spot. Neutral facts only: the classifier's
// description, transit facts, official form prompts / option labels, outcome
// codes. Never contact fields, never a resident's free-typed answer.
// ---------------------------------------------------------------------------
const categoryLabel = (id: string | null | undefined) => (id ? (getCategory(id as never)?.label ?? id) : "Report");

function transitFacts(t: ComplaintDraft["transit"]): string[] {
  if (!t) return [];
  return [
    t.line ? (/^[0-9A-Z]$/.test(t.line) ? `${t.line} train` : t.line) : null,
    t.direction ? `direction ${t.direction}` : null,
    t.station ? `near ${t.station}` : null,
    t.delayMinutes ? `~${t.delayMinutes} min delay` : null,
  ].filter((x): x is string => !!x);
}

const geoOf = (d: Pick<ComplaintDraft, "location">) =>
  d.location.latitude != null && d.location.longitude != null ? { lat: d.location.latitude, lon: d.location.longitude } : null;

/** Episodic: the draft reached READY_FOR_APPROVAL (one item per complaint, upserted). */
export function readyForApprovalItem(d: ComplaintDraft): MemoryItem {
  const facts = transitFacts(d.transit);
  // classifier output, NOT draft.description (for subways that quotes the resident's own words verbatim)
  const neutral = d.classification?.description?.trim() ?? "";
  const head = `${categoryLabel(d.category)}${facts.length ? ` (${facts.join(", ")})` : ""}`;
  return {
    id: `mem_ready_${d.id}`,
    kind: "episodic",
    text: neutral ? `${head}: ${neutral}` : head,
    category: d.category,
    chatId: d.telegramChatId,
    line: d.transit?.line ?? null,
    geo: geoOf(d),
    importance: 0.5,
    data: { complaintId: d.id, draftVersion: d.draftVersion, status: d.status, incidentTime: d.transit?.incidentTime ?? null, photos: d.media.length, borough: d.location.borough ?? d.transit?.borough ?? null },
    source: `complaint:${d.id}`,
    about: [{ table: "complaint", id: d.id }, ...(d.category ? [{ table: "complaint_category" as const, id: d.category }] : [])],
  };
}

/** Episodic: how a filing attempt ended (0.9 when SUBMITTED, else 0.6). The reference number goes in data, not text. */
export function filingOutcomeItem(args: { complaint: ComplaintDraft; attempt: Pick<FilingAttempt, "id" | "category">; status: FilingStatus; errorCode: FilingErrorCode | null; officialRequestNumber: string | null; dryRun?: boolean }): MemoryItem {
  const { complaint: d, attempt, status, errorCode } = args;
  const facts = transitFacts(d.transit);
  const what = status === "SUBMITTED" ? (args.officialRequestNumber ? "was submitted and confirmed with an official reference" : "was submitted") : args.dryRun ? "stopped before the final Submit (dry run)" : `ended ${status}${errorCode ? ` (${errorCode})` : ""}`;
  return {
    id: `mem_outcome_${attempt.id}`,
    kind: "episodic",
    text: `Filing of a ${categoryLabel(attempt.category).toLowerCase()}${facts.length ? ` (${facts.join(", ")})` : ""} ${what}.`,
    category: attempt.category,
    chatId: d.telegramChatId,
    line: d.transit?.line ?? null,
    geo: geoOf(d),
    importance: status === "SUBMITTED" ? 0.9 : 0.6,
    data: { complaintId: d.id, attemptId: attempt.id, status, errorCode, officialRequestNumber: args.officialRequestNumber, dryRun: !!args.dryRun },
    source: `attempt:${attempt.id}`,
    about: [{ table: "filing_attempt", id: attempt.id }, { table: "complaint", id: d.id }],
  };
}

/** Episodic: a live worker question and how the resident answered (option label, or typed-answer length only). */
export function liveQuestionItem(args: { complaint: ComplaintDraft; attemptId: string; question: WorkerQuestion; answer: WorkerAnswer | null; waitedMs: number }): MemoryItem {
  const { complaint: d, question: q, answer } = args;
  const optionLabel = answer?.optionIndex !== undefined ? (q.options?.[answer.optionIndex] ?? null) : null;
  const how = !answer ? "no answer came before the timeout" : optionLabel ? `the resident chose “${optionLabel}”` : `the resident typed an answer (${answer.value.length} chars)`;
  return {
    id: `mem_q_${args.attemptId}_${q.id}`,
    kind: "episodic",
    text: `During filing the ${categoryLabel(d.category).toLowerCase()} form asked: “${q.prompt}” (${q.field}); ${how}.`,
    category: d.category,
    chatId: d.telegramChatId,
    line: d.transit?.line ?? null,
    importance: 0.6,
    data: { complaintId: d.id, attemptId: args.attemptId, questionId: q.id, field: q.field, options: q.options ?? [], answered: !!answer, optionIndex: answer?.optionIndex ?? null, optionLabel, freeTextChars: answer && optionLabel === null ? answer.value.length : null, waitedMs: args.waitedMs },
    source: `attempt:${args.attemptId}`,
    about: [{ table: "filing_attempt", id: args.attemptId }, { table: "complaint", id: d.id }],
  };
}

/** Procedural: an ask-before-approval rule learned from a filing (mirrors workflow_pattern; upserted per pattern). */
export function askPatternItem(p: WorkflowPattern): MemoryItem {
  const h = p.hint as { field?: string; prompt?: string; count?: number; options?: string[] };
  return {
    id: `mem_${p.id}`,
    kind: "procedural",
    text: `${categoryLabel(p.category)} form: ${p.description}${h.prompt ? ` Last prompt: “${h.prompt}”` : ""}`,
    category: p.category,
    chatId: null,
    importance: 0.7,
    data: { patternId: p.id, patternKind: p.kind, field: h.field ?? null, count: h.count ?? null, options: h.options ?? [] },
    source: p.observedInAttemptId ? `attempt:${p.observedInAttemptId}` : "seed",
    about: [{ table: "complaint_category", id: p.category }, ...(p.observedInAttemptId ? [{ table: "filing_attempt" as const, id: p.observedInAttemptId }] : [])],
  };
}

/** Semantic: one fact per category in the registry (source `seed`, deterministic id ⇒ idempotent at every boot). */
export function categorySeedItem(c: CategoryDefinition): MemoryItem {
  return {
    id: `mem_seed_${c.id}`,
    kind: "semantic",
    text: `${c.label} — filed via ${c.officialLabel}. ${c.guidance} Needed before approval: ${c.requiredFields.join(", ")}.`,
    category: c.id,
    chatId: null,
    importance: 0.4,
    data: { officialFormUrl: c.officialFormUrl, articleUrl: c.articleUrl, requiredFields: c.requiredFields, openDataBacked: c.openDataBacked, requiresContactName: c.requiresContactName },
    source: "seed",
    about: [{ table: "complaint_category", id: c.id }],
  };
}

/** Boot: seed the category registry as semantic memory. */
export async function seedCategoryMemory(memory: Pick<AgentMemory, "remember">, categories: CategoryDefinition[] = Object.values(CATEGORIES)): Promise<number> {
  for (const c of categories) await memory.remember(categorySeedItem(c));
  return categories.length;
}

/**
 * What the agent recalls for one complaint (dashboard `GET /api/memory?complaintId=`, demo): the complaint's own
 * memory text as the query, scoped to its resident (own items + world facts) and category.
 */
export async function recallForComplaint(memory: AgentMemory, d: ComplaintDraft, limit = 10): Promise<{ query: string; items: ScoredMemory[] }> {
  const query = readyForApprovalItem(d).text;
  const items = await memory.recall({ text: query, scope: { chatId: d.telegramChatId, category: d.category }, limit });
  return { query, items };
}
