/**
 * #22: the approval card never waits for recall; recall runs afterwards (trace + /api/memory cache).
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ClassificationResult, Embedder, Store } from "../core/contracts.js";
import { EMPTY_LOCATION } from "../core/contracts.js";
import { createOrchestrator, type Orchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory, type AgentMemoryService } from "./agent-memory.js";

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
