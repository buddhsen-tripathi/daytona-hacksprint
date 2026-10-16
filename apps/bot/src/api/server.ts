/**
 * Read-mostly JSON API for the dashboard (+ scripted event endpoint POST /api/event and the
 * optional Telegram webhook). node:http, CORS *.
 *
 * Auth (#23): with OPERATOR_API_TOKEN set, GET /api/* needs `Authorization: Bearer <token>`; with it unset,
 * only loopback callers are trusted (local dev). /api/health is always open. An untrusted caller may still
 * read GET /api/memory?complaintId=… (the complaint id acts as a capability), with chat ids / contact fields
 * redacted. Everything else ⇒ 401 JSON. POST /api/event and /telegram/webhook are unchanged.
 * POST /api/repairs/:id/approve|reject (#13) uses the same operator check (401 otherwise).
 */
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AgentMemory, CatalogEntry, CategoryId, RepairProposal, Store, Tracer } from "../core/contracts.js";
import { CATEGORIES, InboundEvent, MemoryKind } from "../core/contracts.js";
import { createAgentMemory, recallForComplaintCached } from "../services/agent-memory.js";
import { categorySchemaView } from "../services/form-schema-memory.js";
import { decideAndApply } from "../services/postmortem.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { providerReport } from "../integrations/index.js";
import { env, hasTelegram, REPO_ROOT } from "../integrations/env.js";
import { resolveEvidencePath } from "../services/evidence-registry.js";
import type { WebhookHandler } from "../telegram/bot.js";
import { capturedQuestions, createCaptureTransport } from "./capture-transport.js";

export type ApiDeps = {
  store: Store;
  tracer: Tracer;
  orchestrator: Orchestrator;
  /** Agent memory (#4) for GET /api/memory. Absent ⇒ keyword-only recall over the store. */
  memory?: AgentMemory | null;
  /** Set when Telegram runs in webhook mode. Read lazily so the bot can start after the server. */
  getWebhook?: () => WebhookHandler | null;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Bearer token match when OPERATOR_API_TOKEN is set; otherwise a loopback caller counts as the operator. */
export function isOperator(req: IncomingMessage, token = env.OPERATOR_API_TOKEN): boolean {
  if (!token) return LOOPBACK.has(req.socket.remoteAddress ?? "");
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SENSITIVE_KEYS = new Set(["telegramChatId", "chatId", "residentId", "contactName", "contactEmail", "contactPhone"]);

/** Deep-copy with chat ids and contact fields replaced, for responses to unauthenticated callers. */
export function redactSensitive<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redactSensitive) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, SENSITIVE_KEYS.has(k) ? (x == null ? x : "(redacted)") : redactSensitive(x)]),
    ) as T;
  }
  return v;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApiServer(deps: ApiDeps): Server {
  const { store, orchestrator } = deps;
  const memory = deps.memory ?? createAgentMemory({ store });
  const started = new Date().toISOString();

  return createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean); // ["api", "complaints", ":id"]
    try {
      if (path === "/telegram/webhook" && req.method === "POST") {
        const wh = deps.getWebhook?.();
        if (!wh) return json(res, 404, { error: "webhook not enabled" });
        // grammY verifies X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET (401 otherwise).
        if (req.headers["x-telegram-bot-api-secret-token"] !== env.TELEGRAM_WEBHOOK_SECRET) return json(res, 401, { error: "bad secret" });
        await wh(req, res);
        return;
      }
      if (seg[0] !== "api") return json(res, 404, { error: "not found" });

      if (req.method === "GET") {
        const authed = isOperator(req);
        const capabilityRead = seg[1] === "memory" && !seg[2] && url.searchParams.has("complaintId");
        if (!authed && seg[1] !== "health" && !capabilityRead) {
          return json(res, 401, { error: "unauthorized", message: "Authorization: Bearer <OPERATOR_API_TOKEN> required" });
        }
        switch (seg[1]) {
          case "health":
            return json(res, 200, { ok: true, startedAt: started, store: store.backend, telegram: hasTelegram(), providers: providerReport() });
          case "complaints": {
            if (seg[2]) {
              const c = await store.getComplaint(decodeURIComponent(seg[2]));
              if (!c) return json(res, 404, { error: "complaint not found" });
              const attempts = await store.listAttempts({ complaintId: c.id });
              const evidence = attempts.flatMap((a) => a.evidence);
              const traceUrl = c.traceId ? deps.tracer.traceUrl(c.traceId) : null;
              const transitions = await listTransitions(store, c.id);
              const sameIssue = await sameIssueOf(store, c.id);
              return json(res, 200, { complaint: redactComplaint(c), attempts, evidence, transitions, sameIssue, traceUrl, sessionUrl: deps.tracer.sessionUrl(c.telegramChatId) });
            }
            const list = await store.listComplaints({ chatId: url.searchParams.get("chatId") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 100) });
            return json(res, 200, { complaints: list.map(redactComplaint) });
          }
          case "attempts": {
            if (seg[2]) {
              const a = await store.getAttempt(decodeURIComponent(seg[2]));
              return a ? json(res, 200, { attempt: a }) : json(res, 404, { error: "attempt not found" });
            }
            const list = await store.listAttempts({ complaintId: url.searchParams.get("complaintId") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 100) });
            return json(res, 200, { attempts: list });
          }
          case "evidence": {
            if (!seg[2]) return json(res, 400, { error: "evidence id required" });
            const hit = resolveEvidencePath(decodeURIComponent(seg[2]));
            if (!hit) return json(res, 404, { error: "evidence not found" });
            const st = statSync(hit.path);
            res.writeHead(200, { "content-type": hit.mime, "content-length": st.size, "cache-control": "private, max-age=300" });
            createReadStream(hit.path).pipe(res);
            return;
          }
          case "graph": {
            const g = await store.graph({ complaintId: url.searchParams.get("complaintId") ?? undefined });
            return json(res, 200, { ...g, patterns: await allPatterns(store) });
          }
          case "catalog": {
            // NYC311 catalog (#7): SurrealDB rows, else the committed snapshot. ?q= filters title/summary/agency/topic.
            let entries = (await store.listCatalog?.()) ?? [];
            const source = entries.length ? "store" : "snapshot";
            if (!entries.length) entries = readCatalogSnapshot();
            const q = url.searchParams.get("q")?.trim().toLowerCase();
            if (q) entries = entries.filter((e) => [e.title, e.summary, e.agency ?? "", e.topic ?? ""].some((v) => v.toLowerCase().includes(q)));
            if (seg[2]) {
              const hit = entries.find((e) => e.id === decodeURIComponent(seg[2]));
              return hit ? json(res, 200, { entry: hit, source }) : json(res, 404, { error: "catalog entry not found" });
            }
            return json(res, 200, { entries, count: entries.length, source });
          }
          case "categories": {
            // #11: GET /api/categories/:id/schema → the form structure learned from filing runs, with provenance
            if (!seg[2] || seg[3] !== "schema" || seg.length > 4) return json(res, 404, { error: "not found" });
            const view = await categorySchemaView(store, decodeURIComponent(seg[2]));
            return view ? json(res, 200, view) : json(res, 404, { error: "no form schema learned for this category yet" });
          }
          case "memory": {
            // What the agent recalls and why: { items: ScoredMemory[] } with score breakdowns (UI in #14).
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
            const complaintId = url.searchParams.get("complaintId");
            if (complaintId) {
              const c = await store.getComplaint(complaintId);
              if (!c) return json(res, 404, { error: "complaint not found" });
              // cached: true ⇒ answered from the recall run right after the approval card was sent (#22)
              const { query, items, cached } = await recallForComplaintCached(memory, c, limit);
              const body = { complaintId: c.id, query, items, cached };
              return json(res, 200, authed ? body : redactSensitive(body));
            }
            const kind = MemoryKind.safeParse(url.searchParams.get("kind"));
            const items = await memory.recall({ text: url.searchParams.get("q") ?? undefined, kind: kind.success ? kind.data : undefined, limit });
            return json(res, 200, { items });
          }
          case "repairs": {
            // #13: post-mortem repair proposals (+ the screenshots / evidence they cite)
            if (!store.listRepairProposals || !store.getRepairProposal) return json(res, 200, { repairs: [] });
            if (seg[2]) {
              const p = await store.getRepairProposal(decodeURIComponent(seg[2]));
              return p ? json(res, 200, { repair: await withRepairEvidence(store, p) }) : json(res, 404, { error: "repair proposal not found" });
            }
            const st = url.searchParams.get("status");
            const status = st === "pending" || st === "approved" || st === "rejected" ? st : undefined;
            const list = await store.listRepairProposals({ status, limit: Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100)) });
            return json(res, 200, { repairs: await Promise.all(list.map((p) => withRepairEvidence(store, p))) });
          }
          case "workflow-patterns":
            return json(res, 200, { patterns: await allPatterns(store) });
          case "residents": {
            const list = await store.listComplaints({ limit: 500 });
            const chats = [...new Set(list.map((c) => c.telegramChatId))];
            const residents = await Promise.all(chats.map((chatId) => store.getOrCreateResident(chatId, null)));
            return json(res, 200, { residents: residents.map((r) => ({ ...r, contactName: r.contactName ? "(set)" : null, contactEmail: r.contactEmail ? "(set)" : null })) });
          }
          case "official-requests": {
            const chatId = url.searchParams.get("chatId");
            if (chatId) return json(res, 200, { officialRequests: await store.listOfficialRequests(chatId) });
            const list = await store.listComplaints({ limit: 500 });
            const chats = [...new Set(list.map((c) => c.telegramChatId))];
            const all = (await Promise.all(chats.map((c) => store.listOfficialRequests(c)))).flat();
            return json(res, 200, { officialRequests: all });
          }
        }
      }

      // POST /api/repairs/:id/approve | /reject (#13): operator only. Approve applies requiredField changes only.
      if (req.method === "POST" && seg[1] === "repairs") {
        if (!isOperator(req)) return json(res, 401, { error: "unauthorized", message: "Authorization: Bearer <OPERATOR_API_TOKEN> required" });
        const action = seg[3];
        if (!seg[2] || seg.length !== 4 || (action !== "approve" && action !== "reject")) return json(res, 404, { error: "not found" });
        const p = await store.getRepairProposal?.(decodeURIComponent(seg[2]));
        if (!p) return json(res, 404, { error: "repair proposal not found" });
        if (p.status !== "pending") return json(res, 409, { error: `repair proposal already ${p.status}`, repair: p });
        const decided = await decideAndApply({ store, memory }, p, action === "approve" ? "approved" : "rejected");
        return json(res, 200, { repair: await withRepairEvidence(store, decided) });
      }

      // POST /api/event (legacy alias: /api/demo/event).
      if (req.method === "POST" && (seg[1] === "event" || (seg[1] === "demo" && seg[2] === "event"))) {
        const body = JSON.parse((await readBody(req)) || "{}");
        const parsed = InboundEvent.safeParse({ updateId: `api-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, username: null, ...body });
        if (!parsed.success) return json(res, 400, { error: "invalid InboundEvent", issues: parsed.error.issues });
        // A live worker question returns the response early (the filing keeps running): answer it with another
        // POST of a callback event using questions[].options[i].data, or a text event.
        let questionAsked!: () => void;
        const asked = new Promise<"question">((r) => (questionAsked = () => r("question")));
        const transport = createCaptureTransport({ onQuestion: () => questionAsked() });
        const waitForFiling = url.searchParams.get("waitForFiling") !== "false";
        const handled = orchestrator.handle(parsed.data, { transport, waitForFiling });
        const first = await Promise.race([handled.then(() => "done" as const), asked]);
        const complaint = await store.getActiveComplaint(parsed.data.chatId);
        return json(res, 200, {
          messages: transport.messages,
          questions: capturedQuestions(transport.messages),
          pendingQuestions: orchestrator.pendingQuestions?.(parsed.data.chatId) ?? [],
          filingStillRunning: first === "question",
          activeComplaint: complaint ? redactComplaint(complaint) : null,
        });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[api] error:", err);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });
}

export type TransitionRow = { from: string; to: string; reason: string; actor: string; ts: string };

/** Audit rows from store.recordTransition. Memory store: listTransitions(); SurrealDB: raw query on the `transition` table. */
async function listTransitions(store: Store, complaintId: string): Promise<TransitionRow[]> {
  const s = store as Store & {
    listTransitions?: (id: string) => Promise<{ from: string; to: string; reason: string; actor: string; at?: string; ts?: string }[]>;
    query?: (sql: string, vars?: Record<string, unknown>) => Promise<unknown[]>;
  };
  try {
    if (s.listTransitions) return (await s.listTransitions(complaintId)).map((t) => ({ from: t.from, to: t.to, reason: t.reason, actor: t.actor, ts: t.at ?? t.ts ?? "" }));
    if (s.query) {
      const [rows] = (await s.query("SELECT from, to, reason, actor, at FROM transition WHERE complaintId = $id ORDER BY at ASC", { id: complaintId })) as [
        { from: string; to: string; reason: string; actor: string; at: string }[] | undefined,
      ];
      return (rows ?? []).map((t) => ({ from: t.from, to: t.to, reason: t.reason, actor: t.actor, ts: String(t.at ?? "") }));
    }
  } catch (err) {
    console.warn("[api] listTransitions failed:", (err as Error).message);
  }
  return [];
}

/**
 * #5 cluster for the dashboard (UI in #14): the original this complaint belongs to (itself when others joined it),
 * its supporters' complaint ids, and the reports the resident said are different. Complaint ids only.
 */
async function sameIssueOf(store: Store, complaintId: string): Promise<{ originalId: string | null; supporters: number; joined: string[]; notSameAs: string[] } | null> {
  if (!store.getIssueLinks) return null;
  try {
    const own = await store.getIssueLinks(complaintId);
    const originalId = own.sameIssueAs ?? (own.joined.length ? complaintId : null);
    const cluster = originalId && originalId !== complaintId ? await store.getIssueLinks(originalId) : own;
    return { originalId, supporters: originalId ? cluster.supporters : 0, joined: originalId ? cluster.joined : [], notSameAs: own.notSameAs };
  } catch (err) {
    console.warn("[api] getIssueLinks failed:", (err as Error).message);
    return null;
  }
}

/** A proposal plus the evidence rows it cites (same shape as GET /api/complaints/:id evidence) and the attempt outcome. */
async function withRepairEvidence(store: Store, p: RepairProposal) {
  const cited = new Set(p.proposedChanges.flatMap((c) => c.evidence));
  const attempt = await store.getAttempt(p.attemptId).catch(() => null);
  const evidence = (attempt?.evidence ?? []).filter((e) => cited.has(e.id));
  return { ...p, evidence, traceId: attempt?.traceId ?? null, outcome: attempt?.outcome ?? null, errorCode: attempt?.errorCode ?? null };
}

async function allPatterns(store: Store) {
  const combos = (["real"] as const).flatMap((target) => (Object.keys(CATEGORIES) as CategoryId[]).map((category) => ({ target, category })));
  const lists = await Promise.all(combos.map((c) => store.getWorkflowPatterns(c).catch(() => [])));
  return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Strip local file paths / Telegram file ids before returning to the dashboard. */
function redactComplaint<T extends { media: { localPath: string | null; telegramFileId: string }[] }>(c: T): T {
  return { ...c, media: c.media.map((m) => ({ ...m, localPath: m.localPath ? "(stored)" : null, telegramFileId: "(redacted)" })) };
}

export function startApiServer(deps: ApiDeps, port = env.PORT_API): Promise<Server> {
  const server = createApiServer(deps);
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolveP(server));
  });
}

function readCatalogSnapshot(): CatalogEntry[] {
  const p = resolve(REPO_ROOT, "fixtures/nyc311-catalog.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CatalogEntry[]) : [];
}
