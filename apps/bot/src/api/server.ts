/**
 * Read-mostly JSON API for the dashboard (+ scripted event endpoint POST /api/event and the
 * optional Telegram webhook). node:http, CORS *.
 */
import { createReadStream, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AgentMemory, CategoryId, Store, Tracer } from "../core/contracts.js";
import { CATEGORIES, InboundEvent, MemoryKind } from "../core/contracts.js";
import { createAgentMemory, recallForComplaintCached } from "../services/agent-memory.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { providerReport } from "../integrations/index.js";
import { env, hasTelegram } from "../integrations/env.js";
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
    res.setHeader("access-control-allow-headers", "content-type");
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
              return json(res, 200, { complaint: redactComplaint(c), attempts, evidence, transitions, traceUrl, sessionUrl: deps.tracer.sessionUrl(c.telegramChatId) });
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
          case "memory": {
            // What the agent recalls and why: { items: ScoredMemory[] } with score breakdowns (UI in #14).
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
            const complaintId = url.searchParams.get("complaintId");
            if (complaintId) {
              const c = await store.getComplaint(complaintId);
              if (!c) return json(res, 404, { error: "complaint not found" });
              // cached: true ⇒ answered from the recall run right after the approval card was sent (#22)
              const { query, items, cached } = await recallForComplaintCached(memory, c, limit);
              return json(res, 200, { complaintId: c.id, query, items, cached });
            }
            const kind = MemoryKind.safeParse(url.searchParams.get("kind"));
            const items = await memory.recall({ text: url.searchParams.get("q") ?? undefined, kind: kind.success ? kind.data : undefined, limit });
            return json(res, 200, { items });
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
