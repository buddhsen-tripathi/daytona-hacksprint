/**
 * #13: GET /api/repairs, GET /api/repairs/:id, POST /api/repairs/:id/approve|reject behind #23's operator auth.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RepairProposal } from "../core/contracts.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory } from "../services/agent-memory.js";
import { readCurrentSchema } from "../services/form-schema-memory.js";
import { crossStreet2Attempt } from "../services/__fixtures__/postmortem-attempt.js";
import { createApiServer } from "./server.js";

const TOKEN = "test-operator-token";
const proposal = (id: string, after: string): RepairProposal => ({
  id,
  attemptId: crossStreet2Attempt.id,
  complaintId: crossStreet2Attempt.complaintId,
  category: "subway-delay",
  cause: "missing_required_field",
  confidence: 0.7,
  proposedChanges: [{ kind: "requiredField", before: null, after, evidence: ["ev_validate_shot"] }],
  status: "pending",
  createdAt: `2026-10-16T12:0${id.slice(-1)}:00.000Z`,
  decidedAt: null,
});

describe("repairs API (#13)", () => {
  let server: Server;
  let base: string;
  let memory: ReturnType<typeof createAgentMemory>;
  const store = createMemoryStore();
  const prev = process.env.OPERATOR_API_TOKEN;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    await store.createAttempt(crossStreet2Attempt);
    await store.saveRepairProposal!(proposal("rep_1", "Cross Street 2"));
    await store.saveRepairProposal!(proposal("rep_2", "Apartment"));
    server = createApiServer({ store, tracer: createNoopTracer(), memory, orchestrator: {} as Orchestrator });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    if (prev === undefined) delete process.env.OPERATOR_API_TOKEN;
    else process.env.OPERATOR_API_TOKEN = prev;
  });

  it("401 without the operator token (GET and POST)", async () => {
    process.env.OPERATOR_API_TOKEN = TOKEN;
    expect((await fetch(`${base}/api/repairs`)).status).toBe(401);
    expect((await fetch(`${base}/api/repairs/rep_1`)).status).toBe(401);
    expect((await fetch(`${base}/api/repairs/rep_1/approve`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/api/repairs/rep_1/reject`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await store.getRepairProposal!("rep_1"))?.status).toBe("pending");
  });

  it("lists (newest first, ?status=) and shows one with its cited evidence", async () => {
    process.env.OPERATOR_API_TOKEN = TOKEN;
    const list = (await (await fetch(`${base}/api/repairs?status=pending`, { headers: auth })).json()) as { repairs: (RepairProposal & { evidence: { id: string }[] })[] };
    expect(list.repairs.map((r) => r.id)).toEqual(["rep_2", "rep_1"]);
    expect(list.repairs[0]!.evidence.map((e) => e.id)).toEqual(["ev_validate_shot"]);
    const one = await fetch(`${base}/api/repairs/rep_1`, { headers: auth });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { repair: RepairProposal }).repair.id).toBe("rep_1");
    expect((await fetch(`${base}/api/repairs/nope`, { headers: auth })).status).toBe(404);
  });

  it("approve applies the requiredField to the category schema; reject applies nothing; decided ⇒ 409", async () => {
    process.env.OPERATOR_API_TOKEN = TOKEN;
    const a = await fetch(`${base}/api/repairs/rep_1/approve`, { method: "POST", headers: auth });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { repair: RepairProposal }).repair).toMatchObject({ status: "approved", decidedBy: "operator", applied: ["Cross Street 2"] });
    await memory.flush();
    expect((await readCurrentSchema(store, "subway-delay"))?.requiredFields).toEqual(["Cross Street 2"]);

    const r = await fetch(`${base}/api/repairs/rep_2/reject`, { method: "POST", headers: auth });
    expect(((await r.json()) as { repair: RepairProposal }).repair).toMatchObject({ status: "rejected", decidedBy: "operator" });
    expect((await readCurrentSchema(store, "subway-delay"))?.requiredFields).toEqual(["Cross Street 2"]);

    expect((await fetch(`${base}/api/repairs/rep_1/reject`, { method: "POST", headers: auth })).status).toBe(409);
    expect((await fetch(`${base}/api/repairs/rep_1/delete`, { method: "POST", headers: auth })).status).toBe(404);
    const approved = (await (await fetch(`${base}/api/repairs?status=approved`, { headers: auth })).json()) as { repairs: RepairProposal[] };
    expect(approved.repairs.map((x) => x.id)).toEqual(["rep_1"]);
  });
});
