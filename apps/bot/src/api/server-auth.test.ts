/**
 * #23: operator API bearer auth, loopback dev default, redaction for unauthenticated reads.
 */
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ComplaintDraft } from "../core/contracts.js";
import { EMPTY_LOCATION, EMPTY_TRANSIT, nowIso } from "../core/contracts.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory, readyForApprovalItem } from "../services/agent-memory.js";
import { createApiServer, isOperator, redactSensitive } from "./server.js";

const TOKEN = "test-operator-token";
const fakeReq = (remoteAddress: string, authorization?: string) =>
  ({ socket: { remoteAddress }, headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage;

function draft(id: string, chat: string): ComplaintDraft {
  const t = nowIso();
  return {
    id, telegramChatId: chat, residentId: `res_${chat}`, status: "READY_FOR_APPROVAL", category: "subway-delay", triage: "SUPPORTED",
    description: "A train delayed", userMessages: [], location: { ...EMPTY_LOCATION }, media: [], classification: null,
    transit: { ...EMPTY_TRANSIT, line: "A" }, missingFields: [], needsEmergencyReferral: false, confidence: 0.9, duplicates: [],
    duplicateReviewed: true, draftVersion: 1, approvedVersion: null, approvedAt: null, activeAttemptId: null,
    officialRequestNumber: null, statusReason: null, traceId: null, createdAt: t, updatedAt: t,
  } as ComplaintDraft;
}

describe("isOperator", () => {
  it("token unset: trusts loopback only", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isOperator(fakeReq(a), "")).toBe(true);
    expect(isOperator(fakeReq("10.0.0.5"), "")).toBe(false);
    expect(isOperator(fakeReq("10.0.0.5", "Bearer anything"), "")).toBe(false);
  });
  it("token set: requires the exact bearer token, even from loopback", () => {
    expect(isOperator(fakeReq("127.0.0.1"), TOKEN)).toBe(false);
    expect(isOperator(fakeReq("127.0.0.1", "Bearer wrong"), TOKEN)).toBe(false);
    expect(isOperator(fakeReq("10.0.0.5", `Bearer ${TOKEN}`), TOKEN)).toBe(true);
  });
});

describe("redactSensitive", () => {
  it("replaces chat ids and contact fields deeply, keeps nulls", () => {
    const out = redactSensitive({ items: [{ chatId: "c1", text: "hi", nested: { contactEmail: "a@b.c", contactPhone: null } }] });
    expect(out).toEqual({ items: [{ chatId: "(redacted)", text: "hi", nested: { contactEmail: "(redacted)", contactPhone: null } }] });
  });
});

describe("operator API auth over HTTP", () => {
  let server: Server;
  let base: string;
  const prev = process.env.OPERATOR_API_TOKEN;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    for (const c of [draft("cmp_a", "rider-1"), draft("cmp_b", "rider-2")]) {
      await store.saveComplaint(c);
      await memory.remember(readyForApprovalItem(c));
    }
    server = createApiServer({ store, tracer: createNoopTracer(), memory, orchestrator: {} as Orchestrator });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    if (prev === undefined) delete process.env.OPERATOR_API_TOKEN;
    else process.env.OPERATOR_API_TOKEN = prev;
  });

  it("401 without the token on list/detail endpoints and unscoped /api/memory; health stays open", async () => {
    process.env.OPERATOR_API_TOKEN = TOKEN;
    for (const p of ["/api/complaints", "/api/residents", "/api/official-requests", "/api/memory", "/api/memory?kind=procedural", "/api/complaints/cmp_a"]) {
      const res = await fetch(base + p);
      expect(res.status, p).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
    }
    expect((await fetch(`${base}/api/complaints`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("200 with the token, unredacted", async () => {
    process.env.OPERATOR_API_TOKEN = TOKEN;
    const res = await fetch(`${base}/api/complaints`, { headers: auth });
    expect(res.status).toBe(200);
    const { complaints } = (await res.json()) as { complaints: ComplaintDraft[] };
    expect(complaints.map((c) => c.telegramChatId).sort()).toEqual(["rider-1", "rider-2"]);
    expect((await fetch(`${base}/api/memory`, { headers: auth })).status).toBe(200);
  });

  it("/api/memory?complaintId= works without the token but redacts chat ids", async () => {
    process.env.OPERATOR_API_TOKEN = TOKEN;
    const anon = await fetch(`${base}/api/memory?complaintId=cmp_a`);
    expect(anon.status).toBe(200);
    expect(await anon.text()).not.toContain("rider-1");
    const authed = await (await fetch(`${base}/api/memory?complaintId=cmp_a`, { headers: auth })).text();
    expect(authed).toContain("rider-1");
  });

  it("token unset: loopback callers are trusted (local dev default)", async () => {
    delete process.env.OPERATOR_API_TOKEN;
    expect((await fetch(`${base}/api/complaints`)).status).toBe(200);
    expect((await fetch(`${base}/api/memory`)).status).toBe(200);
  });
});
