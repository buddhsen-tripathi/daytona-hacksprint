/**
 * SurrealDB Store (design doc §11). Implements every `Store` method.
 *
 * - SURREALDB_URL empty ⇒ embedded `@surrealdb/node` engine on `mem://`;
 *   set ⇒ remote (SurrealDB Cloud `wss://…/rpc`, root user/pass).
 * - Every record keeps the full contract object in `doc` plus a few indexed
 *   columns (chatId, status, createdAt, lat/lon …) so reads are trivial and
 *   schema drift in the contracts is harmless.
 * - Graph (§11.2): resident->reported->complaint, complaint->located_at->location,
 *   complaint->categorized_as->complaint_category, complaint->resulted_in->official_request,
 *   complaint->possibly_duplicates->official_request (Open Data candidates),
 *   official_request->located_at->location, filing_attempt->attempted->complaint,
 *   filing_attempt->learned->workflow_pattern, workflow_pattern->applies_to->complaint_category,
 *   complaint->has_media->media, filing_attempt->produced->evidence,
 *   memory->about->(complaint|complaint_category|filing_attempt) (agent memory, #4).
 * - Edges are idempotent: `INSERT RELATION IGNORE INTO rel { id: [in, out], in, out }`.
 * - Record ids are always mapped back to plain strings on return.
 * - Any DB failure is logged and rethrown as a typed `StoreError` (the
 *   orchestrator only falls back to the memory store at boot).
 */
import { GeometryPoint, RecordId, Surreal, createRemoteEngines } from "surrealdb";
import type {
  CategoryId,
  ComplaintDraft,
  ComplaintLocation,
  ComplaintState,
  DuplicateCandidate,
  FilingAttempt,
  FilingTarget,
  MemoryAboutRef,
  MemoryHit,
  MemoryKind,
  MemoryRecord,
  MemorySearch,
  OfficialRequest,
  Resident,
  Store,
  RelatedComplaint,
  RelatedComplaints,
  RelatedComplaintsQuery,
  WorkflowPattern,
} from "../core/contracts.js";
import { CATEGORIES, nowIso } from "../core/contracts.js";
import { NOT_REPORTED, NOT_REPORTED_OTHERS, RELATED_DEFAULTS } from "../services/memory.js";
import { env } from "./env.js";

export class StoreError extends Error {
  readonly op: string;
  override readonly cause: unknown;
  constructor(op: string, cause: unknown) {
    super(`[surrealdb] ${op} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StoreError";
    this.op = op;
    this.cause = cause;
  }
}

export type SurrealStoreOptions = {
  /** Override SURREALDB_URL. "" or "mem://" ⇒ embedded in-memory engine. */
  url?: string;
  namespace?: string;
  database?: string;
  username?: string;
  password?: string;
  /** Use a unique random database (tests). */
  isolated?: boolean;
  connectTimeoutMs?: number;
};

export type SurrealStore = Store & {
  backend: "surrealdb-embedded" | "surrealdb";
  /** Whether the HNSW memory index was accepted by the engine (known after init()). */
  readonly vectorIndex: boolean;
  namespace: string;
  database: string;
  /** Delete every 311Relay record (and re-seed categories). Tests/seed only. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Raw SurrealQL for scripts (seed / dashboards). Returns one result per statement. */
  query<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T>;
};

/** Statuses after which a complaint no longer counts as the chat's "active" draft. */
const INACTIVE: ComplaintState[] = ["SUBMITTED", "TRACKING", "CANCELLED", "EMERGENCY_REFERRAL", "OUT_OF_SCOPE"];

export const NODE_TABLES = [
  "resident",
  "complaint",
  "media",
  "official_request",
  "filing_attempt",
  "location",
  "complaint_category",
  "processed_update",
  "transition",
  "workflow_pattern",
  "evidence",
  "memory",
] as const;

/** Relation tables with their IN/OUT types (SurrealDB TYPE RELATION). */
export const RELATIONS: Record<string, { in: string; out: string }> = {
  reported: { in: "resident", out: "complaint" },
  located_at: { in: "complaint|official_request", out: "location" },
  categorized_as: { in: "complaint", out: "complaint_category" },
  resulted_in: { in: "complaint", out: "official_request" },
  possibly_duplicates: { in: "complaint", out: "official_request" },
  attempted: { in: "filing_attempt", out: "complaint" },
  learned: { in: "filing_attempt", out: "workflow_pattern" },
  applies_to: { in: "workflow_pattern", out: "complaint_category" },
  has_media: { in: "complaint", out: "media" },
  produced: { in: "filing_attempt", out: "evidence" },
  /** Remembered issues: same category + same line / within 100 m, recent (dashboard cluster). */
  similar_to: { in: "complaint", out: "complaint" },
  /** #5: a supporter joined another resident's report ("Add me to the existing report"). */
  same_issue_as: { in: "complaint", out: "complaint" },
  /** #5: the resident said it's a different issue (never prompted about that report again). */
  not_same_as: { in: "complaint", out: "complaint" },
  /** Agent memory (#4): what a memory item is about. */
  about: { in: "memory", out: "complaint|complaint_category|filing_attempt" },
};

/** Tables surfaced by `graph()` (media/evidence/audit rows are left out to keep it readable). */
const GRAPH_NODE_TABLES = ["resident", "complaint", "location", "complaint_category", "official_request", "filing_attempt", "workflow_pattern"];
const GRAPH_EDGE_TABLES = ["reported", "located_at", "categorized_as", "resulted_in", "possibly_duplicates", "attempted", "learned", "applies_to", "similar_to", "same_issue_as", "not_same_as"];
const KIND: Record<string, string> = { complaint_category: "category" };

/**
 * Optional ANN index for OpenRouter embeddings (text-embedding-3-small = 1536 dims). HNSW needs one fixed
 * dimension, while the memory stream can also hold 256-dim fallback vectors, so the index lives on a
 * dedicated field that is only set for 1536-dim vectors. Recall itself uses exact
 * vector::similarity::cosine with the structural filters (works on every engine); the index is there for
 * KNN (`embedding_1536 <|k,ef|> $q`) once the stream grows. Defined best-effort: engines without HNSW skip it.
 */
export const HNSW_DIM = 1536;
const HNSW_SQL = `DEFINE INDEX IF NOT EXISTS memory_embedding ON memory FIELDS embedding_${HNSW_DIM} HNSW DIMENSION ${HNSW_DIM} DIST COSINE TYPE F32;`;

function schemaSql(): string {
  const lines: string[] = [];
  for (const t of NODE_TABLES) lines.push(`DEFINE TABLE IF NOT EXISTS ${t} TYPE NORMAL SCHEMALESS;`);
  for (const [rel, io] of Object.entries(RELATIONS)) lines.push(`DEFINE TABLE IF NOT EXISTS ${rel} TYPE RELATION IN ${io.in} OUT ${io.out} SCHEMALESS;`);
  lines.push(
    "DEFINE INDEX IF NOT EXISTS resident_chat ON resident FIELDS chatId UNIQUE;",
    "DEFINE INDEX IF NOT EXISTS complaint_chat ON complaint FIELDS chatId, createdAt;",
    "DEFINE INDEX IF NOT EXISTS complaint_status ON complaint FIELDS status;",
    "DEFINE INDEX IF NOT EXISTS attempt_complaint ON filing_attempt FIELDS complaintId;",
    "DEFINE INDEX IF NOT EXISTS official_request_complaint ON official_request FIELDS complaintId;",
    "DEFINE INDEX IF NOT EXISTS official_request_number ON official_request FIELDS officialRequestNumber;",
    "DEFINE INDEX IF NOT EXISTS transition_complaint ON transition FIELDS complaintId;",
    "DEFINE INDEX IF NOT EXISTS workflow_pattern_route ON workflow_pattern FIELDS target, category;",
    "DEFINE INDEX IF NOT EXISTS memory_kind_category ON memory FIELDS kind, category;",
    "DEFINE INDEX IF NOT EXISTS memory_chat ON memory FIELDS chatId;",
    "DEFINE INDEX IF NOT EXISTS memory_source ON memory FIELDS source;",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const rid = (table: string, id: string) => new RecordId(table, id);

/** RecordId | "table:id" | id → plain id string. */
export function plainId(v: unknown): string {
  if (v instanceof RecordId) return String(v.id);
  if (typeof v === "string") {
    const i = v.indexOf(":");
    return i >= 0 ? v.slice(i + 1).replace(/^⟨|⟩$/g, "").replace(/^`|`$/g, "") : v;
  }
  if (v && typeof v === "object" && "id" in v) return plainId((v as { id: unknown }).id);
  return String(v);
}
function tableOf(v: unknown): string {
  if (v instanceof RecordId) return v.table.name;
  if (typeof v === "string" && v.includes(":")) return v.slice(0, v.indexOf(":"));
  return "";
}

/** Deterministic location key (same scheme as the memory store). */
export function locationKey(loc: Pick<ComplaintLocation, "latitude" | "longitude" | "address">): string | null {
  if (loc.latitude == null && !loc.address) return null;
  const key = loc.latitude != null ? `${loc.latitude.toFixed(5)},${loc.longitude?.toFixed(5)}` : (loc.address ?? "").toLowerCase();
  return `loc_${key.replace(/[^a-z0-9]+/gi, "_")}`;
}

function locationContent(loc: ComplaintLocation) {
  const hasPoint = loc.latitude != null && loc.longitude != null;
  return {
    address: loc.address,
    borough: loc.borough,
    latitude: loc.latitude,
    longitude: loc.longitude,
    source: loc.source,
    withinNyc: loc.withinNyc,
    // GeoJSON point (lon, lat) so geo::distance() works in SurrealQL.
    point: hasPoint ? new GeometryPoint([loc.longitude as number, loc.latitude as number]) : undefined,
    label: loc.address ?? (hasPoint ? `${loc.latitude!.toFixed(5)}, ${loc.longitude!.toFixed(5)}` : "unknown location"),
    updatedAt: nowIso(),
  };
}

const complaintLabel = (c: ComplaintDraft) => `${c.category ?? "uncategorized"} · ${c.status}`;

/** Strip undefined (→ NONE) deeply via JSON round-trip; contracts are JSON-safe. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Builds a multi-statement query with uniquely-named bindings. */
class Batch {
  sql: string[] = [];
  vars: Record<string, unknown> = {};
  private n = 0;
  bind(v: unknown): string {
    const k = `v${this.n++}`;
    this.vars[k] = v;
    return `$${k}`;
  }
  add(stmt: string) {
    this.sql.push(stmt.trim().endsWith(";") ? stmt : `${stmt};`);
  }
  relate(rel: string, from: RecordId, to: RecordId, extra?: Record<string, unknown>) {
    const f = this.bind(from);
    const t = this.bind(to);
    const e = extra ? `, ${Object.keys(extra).map((k) => `${k}: ${this.bind(extra[k])}`).join(", ")}` : "";
    this.add(`INSERT RELATION IGNORE INTO ${rel} { id: [${f}, ${t}], in: ${f}, out: ${t}, createdAt: time::now()${e} } RETURN NONE`);
  }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------
export function createSurrealStore(opts: SurrealStoreOptions = {}): SurrealStore {
  const url = (opts.url ?? env.SURREALDB_URL).trim();
  // embedded engine: mem:// (default) or a local file via surrealkv:// / rocksdb:// (e.g. two demo runs sharing one store)
  const embedded = url === "" || /^(mem|surrealkv|rocksdb):\/\//.test(url);
  const namespace = opts.namespace ?? env.SURREALDB_NAMESPACE;
  const database = opts.isolated ? `test_${Math.random().toString(36).slice(2, 10)}` : (opts.database ?? env.SURREALDB_DATABASE);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8000;

  let db: Surreal | null = null;
  let ready: Promise<void> | null = null;
  let hnsw = false;

  async function connect(): Promise<void> {
    let instance: Surreal;
    if (embedded) {
      // @surrealdb/node is ESM-only + a native addon: load lazily so remote-only setups never touch it.
      const { createNodeEngines } = await import("@surrealdb/node");
      instance = new Surreal({ engines: createNodeEngines() });
      await withTimeout(instance.connect(url || "mem://"), connectTimeoutMs, "embedded connect");
    } else {
      instance = new Surreal({ engines: createRemoteEngines() });
      await withTimeout(
        instance.connect(url, {
          authentication: { username: opts.username ?? env.SURREALDB_USERNAME, password: opts.password ?? env.SURREALDB_PASSWORD },
        }),
        connectTimeoutMs,
        "remote connect",
      );
    }
    // SurrealDB 3.x: namespace/database must exist before USE.
    await withTimeout(
      instance.query(`DEFINE NAMESPACE IF NOT EXISTS ${ident(namespace)}; USE NS ${ident(namespace)}; DEFINE DATABASE IF NOT EXISTS ${ident(database)};`).collect(),
      connectTimeoutMs,
      "define namespace",
    );
    await instance.use({ namespace, database });
    await instance.query(schemaSql()).collect();
    try {
      await instance.query(HNSW_SQL).collect();
      hnsw = true;
    } catch (err) {
      hnsw = false;
      console.warn(`[surrealdb] HNSW index unavailable (exact cosine recall still works): ${(err as Error).message}`);
    }
    db = instance;
    await seedCategories();
  }

  function ensure(): Promise<void> {
    if (!ready) {
      ready = connect().catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  }

  async function q<T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>): Promise<T> {
    if (!db) throw new Error("not connected");
    return (await db.query(sql, vars).collect()) as unknown as T;
  }
  async function run(b: Batch): Promise<unknown[]> {
    if (b.sql.length === 0) return [];
    return q(b.sql.join("\n"), b.vars);
  }

  async function seedCategories() {
    const b = new Batch();
    for (const c of Object.values(CATEGORIES)) {
      b.add(
        `UPSERT ${b.bind(rid("complaint_category", c.id))} CONTENT ${b.bind(
          plain({
            label: c.officialLabel,
            shortLabel: c.label,
            officialRoute: c.officialFormUrl,
            articleUrl: c.articleUrl,
            requiredFields: c.requiredFields,
            openData: c.openData,
            guidance: c.guidance,
          }),
        )} RETURN NONE`,
      );
    }
    await run(b);
  }

  /** Wrap a method: lazy connect, log + typed error on failure. */
  function guard<A extends unknown[], R>(op: string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return async (...a: A) => {
      try {
        await ensure();
        return await fn(...a);
      } catch (err) {
        if (err instanceof StoreError) throw err;
        const e = new StoreError(op, err);
        console.error(e.message);
        throw e;
      }
    };
  }

  // -- location ---------------------------------------------------------------
  function addLocation(b: Batch, loc: ComplaintLocation): RecordId | null {
    const key = locationKey(loc);
    if (!key) return null;
    const r = rid("location", key);
    b.add(`UPSERT ${b.bind(r)} MERGE ${b.bind(locationContent(loc))} RETURN NONE`);
    return r;
  }

  // -- complaint ---------------------------------------------------------------
  async function writeComplaint(c: ComplaintDraft): Promise<ComplaintDraft> {
    const doc = plain(c);
    const b = new Batch();
    const cr = rid("complaint", c.id);
    const cRef = b.bind(cr);
    b.add(
      `UPSERT ${cRef} CONTENT ${b.bind({
        doc,
        chatId: c.telegramChatId,
        residentId: c.residentId,
        status: c.status,
        category: c.category,
        triage: c.triage,
        latitude: c.location.latitude,
        longitude: c.location.longitude,
        normalizedAddress: c.location.address,
        description: c.description,
        traceId: c.traceId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        label: complaintLabel(c),
      })} RETURN NONE`,
    );
    b.relate("reported", rid("resident", c.residentId), cr);
    // #5: `supporters` is derived from same_issue_as edges (a stale copy of the original never resets it)
    b.add(`LET $supporters = array::len((SELECT VALUE id FROM same_issue_as WHERE out = ${cRef}))`);
    b.add(`IF $supporters > 0 { UPDATE ${cRef} SET supporters = $supporters, doc.supporters = $supporters RETURN NONE; }`);

    // category edge: exactly one (or none)
    const cat = c.category ? rid("complaint_category", c.category) : null;
    b.add(`DELETE categorized_as WHERE in = ${cRef} AND out != ${b.bind(cat)}`);
    if (cat) b.relate("categorized_as", cr, cat, { confidence: c.confidence });

    // location edge: exactly one (or none)
    const loc = c.location.source !== "none" ? addLocation(b, c.location) : null;
    b.add(`DELETE located_at WHERE in = ${cRef} AND out != ${b.bind(loc)}`);
    if (loc) b.relate("located_at", cr, loc, { userConfirmed: c.location.userConfirmed });

    for (const m of c.media) {
      const mr = rid("media", m.id);
      b.add(
        `UPSERT ${b.bind(mr)} CONTENT ${b.bind({
          complaintId: c.id,
          type: m.type,
          // Telegram file ids / local paths are NOT stored here (only a reference kind).
          storageReference: m.localPath ? "local:.runs/media" : "telegram",
          mime: m.mime,
          createdAt: m.createdAt,
          label: m.type,
        })} RETURN NONE`,
      );
      b.relate("has_media", cr, mr);
    }
    await run(b);
    return c;
  }

  async function readDocs<T>(sql: string, vars?: Record<string, unknown>, idx = 0): Promise<T[]> {
    const res = await q(sql, vars);
    const rows = (res[idx] ?? []) as { id?: unknown; doc?: T }[];
    return rows.filter((r) => r && r.doc).map((r) => ({ ...(r.doc as T), ...(r.id !== undefined ? { id: plainId(r.id) } : {}) }) as T);
  }
  async function readOne<T>(table: string, id: string): Promise<T | null> {
    const rows = await readDocs<T>("SELECT id, doc FROM $r", { r: rid(table, id) });
    return rows[0] ?? null;
  }

  // -- attempts ----------------------------------------------------------------
  async function writeAttempt(a: FilingAttempt): Promise<FilingAttempt> {
    const doc = plain(a);
    const b = new Batch();
    const ar = rid("filing_attempt", a.id);
    b.add(
      `UPSERT ${b.bind(ar)} CONTENT ${b.bind({
        doc,
        complaintId: a.complaintId,
        target: a.target,
        category: a.category,
        outcome: a.outcome,
        errorCode: a.errorCode,
        sandboxId: a.sandboxId,
        browserSessionId: a.browserSessionId,
        verified: a.verified,
        traceId: a.traceId,
        evidenceReference: a.evidence[0]?.storageReference ?? null,
        createdAt: a.createdAt,
        finishedAt: a.finishedAt,
        label: `${a.target} · ${a.outcome ?? "running"}${a.errorCode ? ` (${a.errorCode})` : ""}`,
      })} RETURN NONE`,
    );
    b.relate("attempted", ar, rid("complaint", a.complaintId), { approvedVersion: a.approvedVersion });
    for (const e of a.evidence) {
      const er = rid("evidence", e.id);
      b.add(`UPSERT ${b.bind(er)} CONTENT ${b.bind({ ...plain(e), label: `${e.type} · ${e.step ?? ""}` })} RETURN NONE`);
      b.relate("produced", ar, er);
    }
    await run(b);
    return a;
  }

  // -- official requests -------------------------------------------------------
  async function writeOfficialRequest(r: OfficialRequest, viaRel: "resulted_in" | null = "resulted_in"): Promise<OfficialRequest> {
    const b = new Batch();
    const orr = rid("official_request", r.id);
    const cr = rid("complaint", r.complaintId);
    b.add(
      `UPSERT ${b.bind(orr)} CONTENT ${b.bind({
        doc: plain(r),
        complaintId: r.complaintId,
        officialRequestNumber: r.officialRequestNumber,
        officialCategory: r.officialCategory,
        status: r.status,
        source: r.statusSource,
        lastCheckedAt: r.lastCheckedAt,
        label: `${r.officialRequestNumber} (${r.status ?? "?"})`,
      })} RETURN NONE`,
    );
    if (viaRel) {
      b.relate(viaRel, cr, orr);
      // official_request -> located_at -> (the complaint's location)
      const o = b.bind(orr);
      b.add(`LET $loc = (SELECT VALUE out FROM located_at WHERE in = ${b.bind(cr)} LIMIT 1)[0]`);
      b.add(`IF $loc { INSERT RELATION IGNORE INTO located_at { id: [${o}, $loc], in: ${o}, out: $loc, createdAt: time::now() } RETURN NONE; }`);
    }
    await run(b);
    return r;
  }

  // -- agent memory (#4) --------------------------------------------------------
  /** WHERE clause shared by searchMemory/listMemory (same semantics as memoryMatches() in services/agent-memory.ts). */
  function memoryWhere(b: Batch, f: Omit<MemorySearch, "limit" | "embedding" | "embedModel"> & { source?: string }): string {
    const c: string[] = [];
    if (f.kind) c.push(`kind = ${b.bind(f.kind)}`);
    if (f.category) c.push(`category = ${b.bind(f.category)}`);
    // resident scope: own items + world facts (chatId null), never other residents'
    if (f.chatId != null) c.push(`(chatId = ${b.bind(f.chatId)} OR chatId = NONE OR chatId = NULL)`);
    if (f.line) c.push(`line = ${b.bind(f.line)}`);
    if (f.geo) {
      c.push(
        `type::is_number(lat) AND type::is_number(lon) AND geo::distance(type::point([lon, lat]), ${b.bind(new GeometryPoint([f.geo.lon, f.geo.lat]))}) <= ${b.bind(f.geo.radiusMeters)}`,
      );
    }
    if (f.sinceMs != null) c.push(`createdMs >= ${b.bind((f.nowMs ?? Date.now()) - f.sinceMs)}`);
    if (f.about) c.push(`id INSIDE (SELECT VALUE in FROM about WHERE out = ${b.bind(rid(f.about.table, f.about.id))})`);
    if (f.source) c.push(`source = ${b.bind(f.source)}`);
    return c.length ? `WHERE ${c.join(" AND ")}` : "";
  }

  const MEMORY_COLS = "id, kind, category, chatId, line, lat, lon, text, embedModel, importance, data, source, about, createdAt";
  type MemRow = Omit<MemoryRecord, "embedding" | "geo" | "id"> & { id: unknown; lat?: number | null; lon?: number | null; similarity?: number | null };
  const toMemory = (r: MemRow): Omit<MemoryRecord, "embedding"> => ({
    id: plainId(r.id),
    kind: r.kind,
    text: r.text,
    category: r.category ?? null,
    chatId: r.chatId ?? null,
    line: r.line ?? null,
    geo: typeof r.lat === "number" && typeof r.lon === "number" ? { lat: r.lat, lon: r.lon } : null,
    importance: typeof r.importance === "number" ? r.importance : 0,
    data: (r.data ?? {}) as Record<string, unknown>,
    source: r.source,
    about: (r.about ?? []) as MemoryAboutRef[],
    embedModel: r.embedModel ?? null,
    createdAt: String(r.createdAt),
  });

  async function writeMemory(m: MemoryRecord): Promise<void> {
    const b = new Batch();
    const mr = rid("memory", m.id);
    b.add(
      `UPSERT ${b.bind(mr)} CONTENT ${b.bind({
        kind: m.kind,
        category: m.category,
        chatId: m.chatId,
        line: m.line,
        lat: m.geo?.lat ?? null,
        lon: m.geo?.lon ?? null,
        text: m.text,
        embedding: m.embedding,
        ...(hnsw && m.embedding?.length === HNSW_DIM ? { [`embedding_${HNSW_DIM}`]: m.embedding } : {}),
        embedModel: m.embedModel,
        embedDim: m.embedding?.length ?? null,
        importance: m.importance,
        data: plain(m.data),
        source: m.source,
        about: plain(m.about),
        createdAt: m.createdAt,
        createdMs: Date.parse(m.createdAt),
        label: `${m.kind} · ${m.text.slice(0, 60)}`,
      })} RETURN NONE`,
    );
    for (const a of m.about) b.relate("about", mr, rid(a.table, a.id));
    await run(b);
  }

  async function searchMemoryImpl(q: MemorySearch): Promise<MemoryHit[]> {
    const b = new Batch();
    const where = memoryWhere(b, q);
    const vec = q.embedding?.length && q.embedModel ? q.embedding : null;
    // cosine only between vectors of the same model and length (vector::similarity::cosine errors on mismatched dims)
    const sim = vec
      ? `(IF embedModel = ${b.bind(q.embedModel)} AND type::is_array(embedding) AND array::len(embedding) = ${b.bind(vec.length)} THEN vector::similarity::cosine(embedding, ${b.bind(vec)}) ELSE NONE END)`
      : "NONE";
    const order = vec ? "ORDER BY similarity DESC, createdMs DESC" : "ORDER BY createdMs DESC";
    b.add(`SELECT ${MEMORY_COLS}, createdMs, ${sim} AS similarity FROM memory ${where} ${order} LIMIT ${b.bind(q.limit)}`);
    const [rows] = (await run(b)) as [MemRow[]];
    return (rows ?? []).map((r) => ({ ...toMemory(r), similarity: typeof r.similarity === "number" ? r.similarity : null }));
  }

  // ---------------------------------------------------------------------------
  const store: SurrealStore = {
    backend: embedded ? "surrealdb-embedded" : "surrealdb",
    get vectorIndex() {
      return hnsw;
    },
    namespace,
    database,

    init: guard("init", async () => {}),

    query: guard("query", async <T extends unknown[] = unknown[]>(sql: string, vars?: Record<string, unknown>) => q<T>(sql, vars)) as SurrealStore["query"],

    reset: guard("reset", async () => {
      const tables = [...NODE_TABLES, ...Object.keys(RELATIONS)];
      await q(tables.map((t) => `DELETE ${t};`).join("\n"));
      await seedCategories();
    }),

    close: async () => {
      const d = db;
      db = null;
      ready = null;
      if (d) await d.close().catch(() => {});
    },

    // -- residents -------------------------------------------------------------
    getOrCreateResident: guard("getOrCreateResident", async (chatId: string, username: string | null) => {
      const id = `res_${chatId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const r = rid("resident", id);
      const fresh: Resident = {
        id,
        telegramChatId: chatId,
        telegramUsername: username,
        preferredLanguage: null,
        contactName: null,
        contactEmail: null,
        createdAt: nowIso(),
      };
      const res = await q(
        `INSERT IGNORE INTO resident { id: $r, chatId: $chat, doc: $doc, createdAt: $doc.createdAt, label: $label } RETURN NONE;
         SELECT id, doc FROM $r;`,
        { r, chat: chatId, doc: plain(fresh), label: username ?? chatId },
      );
      const row = ((res[1] ?? []) as { doc: Resident }[])[0];
      const current: Resident = row?.doc ? { ...row.doc, id } : fresh;
      if (username && current.telegramUsername !== username) {
        const next = { ...current, telegramUsername: username };
        await q("UPDATE $r SET doc = $doc, label = $label RETURN NONE", { r, doc: plain(next), label: username });
        return next;
      }
      return current;
    }),

    updateResident: guard("updateResident", async (id: string, patch: Partial<Resident>) => {
      const current = await readOne<Resident>("resident", id);
      if (!current) throw new Error(`resident ${id} not found`);
      const next: Resident = { ...current, ...patch, id: current.id };
      await q("UPDATE $r SET doc = $doc, label = $label RETURN NONE", {
        r: rid("resident", id),
        doc: plain(next),
        label: next.telegramUsername ?? next.telegramChatId,
      });
      return next;
    }),

    // -- complaints ------------------------------------------------------------
    createComplaint: guard("createComplaint", writeComplaint),
    saveComplaint: guard("saveComplaint", writeComplaint),
    getComplaint: guard("getComplaint", (id: string) => readOne<ComplaintDraft>("complaint", id)),

    getActiveComplaint: guard("getActiveComplaint", async (chatId: string) => {
      const rows = await readDocs<ComplaintDraft>(
        "SELECT id, doc, createdAt FROM complaint WHERE chatId = $chat AND status NOTINSIDE $inactive ORDER BY createdAt DESC LIMIT 1",
        { chat: chatId, inactive: INACTIVE },
      );
      return rows[0] ?? null;
    }),

    listComplaints: guard("listComplaints", async (args?: { chatId?: string; limit?: number }) => {
      const where = args?.chatId ? "WHERE chatId = $chat" : "";
      return readDocs<ComplaintDraft>(`SELECT id, doc, createdAt FROM complaint ${where} ORDER BY createdAt DESC LIMIT $limit`, {
        chat: args?.chatId,
        limit: args?.limit ?? 100,
      });
    }),

    recordTransition: guard(
      "recordTransition",
      async (complaintId: string, from: ComplaintState, to: ComplaintState, reason: string, actor: "user" | "system" | "llm") => {
        await q("CREATE transition CONTENT { complaintId: $id, complaint: $c, from: $from, to: $to, reason: $reason, actor: $actor, at: $at, ts: time::now() } RETURN NONE", {
          id: complaintId,
          c: rid("complaint", complaintId),
          from,
          to,
          reason: reason.slice(0, 500),
          actor,
          at: nowIso(),
        });
      },
    ),

    // -- graph side tables -----------------------------------------------------
    upsertLocation: guard("upsertLocation", async (loc: ComplaintLocation) => {
      const b = new Batch();
      const r = addLocation(b, loc);
      if (!r) return null;
      await run(b);
      return String(r.id);
    }),

    linkDuplicates: guard("linkDuplicates", async (complaintId: string, candidates: DuplicateCandidate[]) => {
      const cr = rid("complaint", complaintId);
      const keep = candidates.map((d) => rid("official_request", `sr_${d.uniqueKey}`));
      const b = new Batch();
      b.add(`DELETE possibly_duplicates WHERE in = ${b.bind(cr)} AND out NOTINSIDE ${b.bind(keep)}`);
      candidates.forEach((d, i) => {
        const orr = keep[i]!;
        const req: OfficialRequest = {
          id: `sr_${d.uniqueKey}`,
          complaintId,
          officialRequestNumber: d.uniqueKey,
          officialCategory: d.descriptor ? `${d.complaintType} / ${d.descriptor}` : d.complaintType,
          status: d.status,
          statusSource: "open-data",
          lastCheckedAt: nowIso(),
          receiptUrl: null,
        };
        b.add(
          `UPSERT ${b.bind(orr)} MERGE ${b.bind({
            doc: plain(req),
            complaintId,
            officialRequestNumber: d.uniqueKey,
            officialCategory: req.officialCategory,
            status: d.status,
            source: "open-data",
            createdDate: d.createdDate,
            closedDate: d.closedDate,
            resolutionDescription: d.resolutionDescription,
            lastCheckedAt: req.lastCheckedAt,
            label: `311 #${d.uniqueKey} (${d.status ?? "?"})`,
          })} RETURN NONE`,
        );
        b.relate("possibly_duplicates", cr, orr, {
          matchScore: d.matchScore,
          distanceMeters: d.distanceMeters,
          ageDays: d.ageDays,
          scoreBreakdown: plain(d.scoreBreakdown),
        });
        if (d.latitude != null && d.longitude != null) {
          const loc = addLocation(b, {
            latitude: d.latitude,
            longitude: d.longitude,
            address: d.incidentAddress,
            borough: null,
            rawInput: null,
            source: "text",
            userConfirmed: false,
            withinNyc: true,
          });
          if (loc) b.relate("located_at", orr, loc);
        }
      });
      await run(b);
    }),

    // -- filing ----------------------------------------------------------------
    createAttempt: guard("createAttempt", writeAttempt),
    saveAttempt: guard("saveAttempt", writeAttempt),
    getAttempt: guard("getAttempt", (id: string) => readOne<FilingAttempt>("filing_attempt", id)),
    listAttempts: guard("listAttempts", async (args?: { complaintId?: string; limit?: number }) => {
      const where = args?.complaintId ? "WHERE complaintId = $cid" : "";
      return readDocs<FilingAttempt>(`SELECT id, doc, createdAt FROM filing_attempt ${where} ORDER BY createdAt DESC LIMIT $limit`, {
        cid: args?.complaintId,
        limit: args?.limit ?? 100,
      });
    }),

    saveOfficialRequest: guard("saveOfficialRequest", (r: OfficialRequest) =>
      writeOfficialRequest(r, r.statusSource === "open-data" ? null : "resulted_in"),
    ),

    listOfficialRequests: guard("listOfficialRequests", async (chatId: string) => {
      if (!chatId) {
        return readDocs<OfficialRequest>("SELECT id, doc, lastCheckedAt FROM official_request WHERE source != 'open-data' ORDER BY lastCheckedAt DESC");
      }
      return readDocs<OfficialRequest>(
        `SELECT id, doc, lastCheckedAt FROM official_request
         WHERE source != 'open-data' AND complaintId INSIDE (SELECT VALUE record::id(id) FROM complaint WHERE chatId = $chat)
         ORDER BY lastCheckedAt DESC`,
        { chat: chatId },
      );
    }),

    // -- idempotency -----------------------------------------------------------
    markUpdateProcessed: guard("markUpdateProcessed", async (updateId: string) => {
      const res = await q("INSERT IGNORE INTO processed_update { id: $id, ts: time::now() } RETURN id", { id: rid("processed_update", updateId) });
      return ((res[0] ?? []) as unknown[]).length > 0;
    }),

    // -- workflow memory (§11.3) ----------------------------------------------
    recordWorkflowPattern: guard("recordWorkflowPattern", async (p: WorkflowPattern) => {
      const b = new Batch();
      const pr = rid("workflow_pattern", p.id);
      b.add(
        `UPSERT ${b.bind(pr)} CONTENT ${b.bind({
          doc: plain(p),
          target: p.target,
          category: p.category,
          kind: p.kind,
          outcome: p.outcome,
          observedInAttemptId: p.observedInAttemptId,
          createdAt: p.createdAt,
          label: `${p.target} · ${p.kind}`,
        })} RETURN NONE`,
      );
      b.relate("applies_to", pr, rid("complaint_category", p.category));
      if (p.observedInAttemptId) b.relate("learned", rid("filing_attempt", p.observedInAttemptId), pr);
      await run(b);
    }),

    getWorkflowPatterns: guard("getWorkflowPatterns", async (args: { target: FilingTarget; category: CategoryId }) =>
      readDocs<WorkflowPattern>(
        "SELECT id, doc, createdAt FROM workflow_pattern WHERE target = $target AND category = $category ORDER BY createdAt DESC LIMIT 50",
        { target: args.target, category: args.category },
      ),
    ),

    // -- remembered issues (§8.1 context collector) -----------------------------
    findRelatedComplaints: guard("findRelatedComplaints", async (args: RelatedComplaintsQuery): Promise<RelatedComplaints> => {
      const subway = !!args.line;
      const geo = !subway && args.lat != null && args.lon != null;
      if (!subway && !geo) return { mine: [], others: { reports: 0, residents: 0, latestAt: null, oldestAt: null, ids: [] } };
      // Same line (subway) or within $radius metres (location categories, GeoJSON point (lon, lat)).
      const scope = subway
        ? "doc.transit.line = $line"
        : "type::is_number(latitude) AND type::is_number(longitude) AND geo::distance(type::point([longitude, latitude]), $pt) <= $radius";
      const dist = geo ? "geo::distance(type::point([longitude, latitude]), $pt)" : "NONE";
      const res = await q<[RelRow[], RelRow[]]>(
        `-- 1. your own reports: same resident, same category, last 24 h
         SELECT id, chatId, status, createdAt, doc.officialRequestNumber AS sr, doc.statusReason AS reason, doc.transit.line AS line, ${dist} AS distanceMeters
         FROM complaint
         WHERE chatId = $chat AND category = $category AND id != $current AND status NOTINSIDE $notReported
           AND <datetime> createdAt > time::now() - <duration> $mineWindow
           AND ${scope}
         ORDER BY createdAt DESC LIMIT 5;
         -- 2. other residents: same category, last 2 h (counted, never shown)
         SELECT id, chatId, createdAt
         FROM complaint
         WHERE chatId != $chat AND category = $category AND status NOTINSIDE $notReportedOthers
           AND <datetime> createdAt > time::now() - <duration> $othersWindow
           AND ${scope}
         ORDER BY createdAt DESC LIMIT 200;`,
        {
          chat: args.chatId,
          category: args.category,
          current: rid("complaint", args.complaintId),
          line: args.line ?? null,
          pt: geo ? new GeometryPoint([args.lon as number, args.lat as number]) : null,
          radius: args.radiusMeters ?? RELATED_DEFAULTS.radiusMeters,
          notReported: [...NOT_REPORTED],
          notReportedOthers: [...NOT_REPORTED_OTHERS],
          mineWindow: duration(args.sinceMs ?? RELATED_DEFAULTS.sinceMs),
          othersWindow: duration(args.othersSinceMs ?? RELATED_DEFAULTS.othersSinceMs),
        },
      );
      const mine: RelatedComplaint[] = (res[0] ?? []).map((r) => ({
        id: plainId(r.id),
        status: r.status as ComplaintState,
        createdAt: String(r.createdAt),
        officialRequestNumber: (r.sr as string | null | undefined) ?? null,
        statusReason: (r.reason as string | null | undefined) ?? null,
        line: (r.line as string | null | undefined) ?? null,
        distanceMeters: typeof r.distanceMeters === "number" ? r.distanceMeters : null,
      }));
      const others = res[1] ?? [];
      return {
        mine,
        others: {
          reports: others.length,
          residents: new Set(others.map((r) => String(r.chatId))).size,
          latestAt: others[0] ? String(others[0].createdAt) : null,
          oldestAt: others.length ? String(others[others.length - 1]!.createdAt) : null,
          ids: others.slice(0, 10).map((r) => plainId(r.id)),
        },
      };
    }),

    linkSimilarComplaints: guard("linkSimilarComplaints", async (complaintId: string, similarIds: string[]) => {
      const b = new Batch();
      const cr = rid("complaint", complaintId);
      for (const id of new Set(similarIds)) if (id !== complaintId) b.relate("similar_to", cr, rid("complaint", id));
      await run(b);
    }),

    // -- same issue across residents (#5) -----------------------------------------
    linkSameIssue: guard("linkSameIssue", async (supporterId: string, originalId: string) => {
      const b = new Batch();
      const o = rid("complaint", originalId);
      if (supporterId !== originalId) b.relate("same_issue_as", rid("complaint", supporterId), o);
      const oRef = b.bind(o);
      b.add(`LET $n = array::len((SELECT VALUE id FROM same_issue_as WHERE out = ${oRef}))`);
      b.add(`IF $n > 0 { UPDATE ${oRef} SET supporters = $n, doc.supporters = $n RETURN NONE; }`);
      b.add("RETURN $n");
      const res = await run(b);
      const n = res[res.length - 1];
      return typeof n === "number" ? n : 0;
    }),
    linkNotSameIssue: guard("linkNotSameIssue", async (complaintId: string, otherId: string) => {
      if (complaintId === otherId) return;
      const b = new Batch();
      b.relate("not_same_as", rid("complaint", complaintId), rid("complaint", otherId));
      await run(b);
    }),
    getIssueLinks: guard("getIssueLinks", async (complaintId: string) => {
      const [out, joined, notSame] = await q<[unknown[], { in: unknown; createdAt: unknown }[], unknown[]]>(
        `SELECT VALUE out FROM same_issue_as WHERE in = $c;
         SELECT in, createdAt FROM same_issue_as WHERE out = $c ORDER BY createdAt ASC;
         SELECT VALUE out FROM not_same_as WHERE in = $c;`,
        { c: rid("complaint", complaintId) },
      );
      const ids = (joined ?? []).map((r) => plainId(r.in));
      return { sameIssueAs: out?.[0] ? plainId(out[0]) : null, joined: ids, notSameAs: (notSame ?? []).map(plainId), supporters: ids.length };
    }),

    // -- agent memory (#4) -------------------------------------------------------
    insertMemory: guard("insertMemory", writeMemory),
    searchMemory: guard("searchMemory", searchMemoryImpl),
    listMemory: guard("listMemory", async (args?: { kind?: MemoryKind; category?: string; chatId?: string; source?: string; about?: MemoryAboutRef; limit?: number }) => {
      const b = new Batch();
      const where = memoryWhere(b, { kind: args?.kind, category: args?.category, chatId: args?.chatId, source: args?.source, about: args?.about });
      b.add(`SELECT ${MEMORY_COLS}, createdMs FROM memory ${where} ORDER BY createdMs DESC LIMIT ${b.bind(args?.limit ?? 100)}`);
      const [rows] = (await run(b)) as [MemRow[]];
      return (rows ?? []).map(toMemory);
    }),

    // -- graph -----------------------------------------------------------------
    graph: guard("graph", async (args?: { complaintId?: string }) => {
      type EdgeRow = { in: unknown; out: unknown; rel: string };
      type NodeRow = { id: unknown; label?: string };
      const edgesFrom = GRAPH_EDGE_TABLES.join(", ");
      let edgeRows: EdgeRow[];
      let nodeRows: NodeRow[];

      if (args?.complaintId) {
        const c = rid("complaint", args.complaintId);
        const res = await q<[EdgeRow[]]>(`SELECT in, out, record::tb(id) AS rel FROM ${edgesFrom} WHERE in = $c OR out = $c`, { c });
        const hop1 = res[0] ?? [];
        // second hop for official requests / attempts so their location + learned patterns show up
        const neighbours = hop1
          .map((e) => (tableOf(e.in) === "complaint" ? e.out : e.in))
          .filter((n) => ["official_request", "filing_attempt"].includes(tableOf(n)));
        let hop2: EdgeRow[] = [];
        if (neighbours.length) {
          const r2 = await q<[EdgeRow[]]>("SELECT in, out, record::tb(id) AS rel FROM located_at, learned WHERE in INSIDE $n", { n: neighbours });
          hop2 = r2[0] ?? [];
        }
        edgeRows = [...hop1, ...hop2];
        const ids = new Map<string, unknown>();
        ids.set(`complaint:${args.complaintId}`, c);
        for (const e of edgeRows) {
          ids.set(`${tableOf(e.in)}:${plainId(e.in)}`, e.in);
          ids.set(`${tableOf(e.out)}:${plainId(e.out)}`, e.out);
        }
        const nr = await q<[NodeRow[]]>("SELECT id, label FROM $ids", { ids: [...ids.values()] });
        nodeRows = nr[0] ?? [];
      } else {
        const res = await q<[NodeRow[], EdgeRow[]]>(
          `SELECT id, label FROM ${GRAPH_NODE_TABLES.join(", ")} LIMIT 2000;
           SELECT in, out, record::tb(id) AS rel FROM ${edgesFrom} LIMIT 5000;`,
        );
        nodeRows = res[0] ?? [];
        edgeRows = res[1] ?? [];
      }

      const nodes = new Map<string, { id: string; kind: string; label: string }>();
      for (const n of nodeRows) {
        if (!n?.id) continue;
        const t = tableOf(n.id);
        if (!GRAPH_NODE_TABLES.includes(t)) continue;
        const id = plainId(n.id);
        nodes.set(id, { id, kind: KIND[t] ?? t, label: n.label ?? id });
      }
      const seen = new Set<string>();
      const edges: { from: string; to: string; rel: string }[] = [];
      for (const e of edgeRows) {
        const from = plainId(e.in);
        const to = plainId(e.out);
        const key = `${from}|${e.rel}|${to}`;
        if (seen.has(key) || !nodes.has(from) || !nodes.has(to)) continue;
        seen.add(key);
        edges.push({ from, to, rel: e.rel });
      }
      return { nodes: [...nodes.values()], edges };
    }),
  };

  return store;
}

type RelRow = { id: unknown; chatId: unknown; status?: unknown; createdAt: unknown; sr?: unknown; reason?: unknown; line?: unknown; distanceMeters?: unknown };

/** ms → SurrealQL duration string ("1440m"); cast with `<duration>` in the query. */
function duration(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Namespace/database identifiers are interpolated (SurrealQL can't bind them): allow only safe chars. */
function ident(s: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`invalid SurrealDB identifier: ${s}`);
  return s;
}
