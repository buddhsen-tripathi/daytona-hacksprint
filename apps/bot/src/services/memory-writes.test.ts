/**
 * Agent memory write points (#4): READY_FOR_APPROVAL (orchestrator), filing outcome + live question/answer +
 * learned ask rules (filing service), category seeds (boot). No contact fields or typed answers in memory text.
 */
import { describe, expect, it } from "vitest";
import type { BrowserProvider, ClassificationResult, ComplaintDraft, Embedder, SandboxProvider, WorkerEvent, WorkerQuestion, WorkerResult } from "../core/contracts.js";
import { CATEGORIES, EMPTY_LOCATION, EMPTY_TRANSIT, nowIso } from "../core/contracts.js";
import { createOrchestrator } from "../core/orchestrator.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory, seedCategoryMemory } from "./agent-memory.js";
import { createFilingService } from "./filing.js";

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

describe("memory write point: READY_FOR_APPROVAL (orchestrator)", () => {
  it("remembers the neutral description + transit facts, never contact fields or the resident's own words", async () => {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
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
    const r = await store.getOrCreateResident("rider-m", null);
    await store.updateResident(r.id, { contactName: "Jane Doe", contactEmail: "jane@example.com" });
    await orch.handle({ kind: "text", chatId: "rider-m", updateId: "u1", text: "Jane here (jane@example.com, 212-555-0100): A train stuck at 14 St 25 min, downtown", username: null });
    await memory.flush();
    const d = (await store.listComplaints({ chatId: "rider-m" }))[0]!;
    expect(d.status).toBe("READY_FOR_APPROVAL");
    const rows = await store.listMemory!({ source: `complaint:${d.id}` });
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m).toMatchObject({ id: `mem_ready_${d.id}`, kind: "episodic", category: "subway-delay", chatId: "rider-m", line: "A", importance: 0.5 });
    expect(m.text).toBe("Subway delay (A train, direction Downtown & Queens, near 14 St, ~25 min delay): The A train was held at 14 St for 25 minutes.");
    expect(m.text).not.toMatch(/Jane|jane@|555/);
    expect(JSON.stringify(m.data)).not.toMatch(/Jane|jane@|555/);
    expect(m.about).toEqual([{ table: "complaint", id: d.id }, { table: "complaint_category", id: "subway-delay" }]);

    // presenting the card again upserts the same item
    await orch.handle({ kind: "command", chatId: "rider-m", updateId: "u2", command: "status", args: "", username: null });
    await memory.flush();
    expect(await store.listMemory!({ source: `complaint:${d.id}` })).toHaveLength(1);
  });
});

describe("memory write points: filing outcome, live question + answer, learned rule (filing service)", () => {
  const Q: WorkerQuestion = { id: "car", field: "free_text", prompt: "Which car were you in?", required: true };
  function approvedDraft(): ComplaintDraft {
    const t = nowIso();
    return {
      id: "cmp_fw",
      telegramChatId: "rider-f",
      residentId: "res_f",
      status: "APPROVED",
      category: "subway-delay",
      triage: "SUPPORTED",
      description: '"my words verbatim, call 212-555-0100"',
      userMessages: [],
      location: { ...EMPTY_LOCATION },
      media: [],
      classification,
      transit: { ...EMPTY_TRANSIT, line: "A", direction: "Downtown & Queens" },
      missingFields: [],
      needsEmergencyReferral: false,
      confidence: 0.95,
      duplicates: [],
      duplicateReviewed: true,
      draftVersion: 1,
      approvedVersion: 1,
      approvedAt: t,
      activeAttemptId: null,
      officialRequestNumber: null,
      statusReason: null,
      traceId: null,
      createdAt: t,
      updatedAt: t,
    };
  }
  const browser: BrowserProvider = {
    name: "local",
    createSession: async () => ({ id: "sess", provider: "local", cdpUrl: null, liveViewUrl: null, close: async () => {}, getRecordingUrl: async () => null }),
  };
  function sandbox(result: (attemptId: string) => WorkerResult): SandboxProvider {
    return {
      name: "local",
      provision: async () => ({
        id: "sbx",
        provider: "local",
        async runWorker(payload, onEvent) {
          const ev: WorkerEvent = { ts: nowIso(), step: "fill", level: "warn", message: "question", data: { question: Q } };
          onEvent(ev);
          await new Promise((r) => setTimeout(r, 20));
          return { result: { ...result(payload.attemptId), steps: [ev, ...result(payload.attemptId).steps] }, stdout: "", exitCode: 0 };
        },
        answerQuestion: async () => {},
        downloadEvidence: async () => {
          throw new Error("no evidence in tests");
        },
        destroy: async () => {},
      }),
    };
  }
  const base = (attemptId: string): Omit<WorkerResult, "status" | "errorCode"> => ({
    attemptId,
    officialRequestNumber: null,
    officialReceiptUrl: null,
    confirmationText: null,
    submitClicked: false,
    finalUrl: null,
    steps: [],
    evidence: [],
    message: null,
    startedAt: nowIso(),
    finishedAt: nowIso(),
  });

  async function run(result: (attemptId: string) => WorkerResult, typed: string) {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    await store.saveComplaint(approvedDraft());
    const filing = createFilingService({ store, tracer: createNoopTracer(), memory, sandboxProvider: sandbox(result), browserProvider: browser });
    const resident = await store.getOrCreateResident("rider-f", null);
    const outcome = await filing.executeFiling(approvedDraft(), { resident, onProgress: () => {}, onQuestion: async () => ({ value: typed }) });
    await memory.flush();
    return { store, outcome, rows: await store.listMemory!({ about: { table: "filing_attempt", id: outcome.attemptId } }) };
  }

  it("stalled filing: outcome (0.6), question with typed-answer length only, and the learned ask rule (procedural)", async () => {
    const stalledMsg = "The MTA form now requires the car number.";
    const { outcome, rows, store } = await run(
      (id) => ({
        ...base(id),
        status: "HUMAN_ACTION_REQUIRED",
        errorCode: "UNEXPECTED_REQUIRED_FIELD",
        message: stalledMsg,
        steps: [{ ts: nowIso(), step: "fill", level: "warn", message: `outcome HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD: ${stalledMsg}`, data: { label: "Car number" } }],
      }),
      "car 8512, I'm Jane Doe",
    );
    expect(outcome.status).toBe("HUMAN_ACTION_REQUIRED");
    const byKind = Object.fromEntries(rows.map((r) => [r.id.split("_")[1], r]));
    expect(byKind.outcome).toMatchObject({ kind: "episodic", importance: 0.6, chatId: "rider-f", line: "A", source: `attempt:${outcome.attemptId}`, data: { status: "HUMAN_ACTION_REQUIRED", errorCode: "UNEXPECTED_REQUIRED_FIELD", officialRequestNumber: null } });
    expect(byKind.outcome!.text).toBe("Filing of a subway delay (A train, direction Downtown & Queens) ended HUMAN_ACTION_REQUIRED (UNEXPECTED_REQUIRED_FIELD).");
    expect(byKind.q).toMatchObject({ kind: "episodic", importance: 0.6, data: { questionId: "car", answered: true, optionLabel: null, freeTextChars: "car 8512, I'm Jane Doe".length } });
    expect(byKind.q!.text).toBe(`During filing the subway delay form asked: “Which car were you in?” (free_text); the resident typed an answer (${"car 8512, I'm Jane Doe".length} chars).`);
    for (const r of rows) expect(`${r.text} ${JSON.stringify(r.data)}`).not.toMatch(/Jane|8512|555|verbatim/);
    expect(byKind.wp).toMatchObject({ kind: "procedural", chatId: null, importance: 0.7, category: "subway-delay" });
    expect((await store.listMemory!({ kind: "procedural" })).map((r) => (r.data as { field?: string }).field).sort()).toEqual(["car_number", "which_car_were_you_in"]);
  });

  it("a slow embedder never delays the filing outcome (writes land on flush)", async () => {
    const store = createMemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Embedder = { model: "slow/1", dim: 1, embed: async (texts) => (await gate, { model: "slow/1", vectors: texts.map(() => [1]) }) };
    const memory = createAgentMemory({ store, embedder: slow });
    await store.saveComplaint(approvedDraft());
    const filing = createFilingService({ store, tracer: createNoopTracer(), memory, sandboxProvider: sandbox((id) => ({ ...base(id), status: "FAILED", errorCode: "SANDBOX_ERROR" })), browserProvider: browser });
    const resident = await store.getOrCreateResident("rider-f", null);
    const outcome = await filing.executeFiling(approvedDraft(), { resident, onProgress: () => {}, onQuestion: async () => ({ value: "x" }) });
    expect(outcome.status).toBe("FAILED");
    expect(await store.listMemory!({ source: `attempt:${outcome.attemptId}` })).toHaveLength(0); // still embedding
    release();
    await memory.flush();
    expect((await store.listMemory!({ source: `attempt:${outcome.attemptId}` })).map((r) => r.id)).toContain(`mem_outcome_${outcome.attemptId}`);
  });

  it("verified SUBMITTED outcome is remembered with importance 0.9; the reference stays in data", async () => {
    const { outcome, rows } = await run(
      (id) => ({ ...base(id), status: "SUBMITTED", errorCode: null, officialRequestNumber: "MTA-123456", confirmationText: "Thank you. Reference MTA-123456", submitClicked: true, evidence: [{ name: "05-confirm.png", type: "screenshot", step: "confirm", summary: "confirmation" }] }),
      "x",
    );
    expect(outcome.status).toBe("SUBMITTED");
    const o = rows.find((r) => r.id.startsWith("mem_outcome_"))!;
    expect(o).toMatchObject({ importance: 0.9, data: { status: "SUBMITTED", officialRequestNumber: "MTA-123456" } });
    expect(o.text).toBe("Filing of a subway delay (A train, direction Downtown & Queens) was submitted and confirmed with an official reference.");
  });
});

describe("memory write point: category registry seed (boot)", () => {
  it("one semantic item per category, idempotent", async () => {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    expect(await seedCategoryMemory(memory)).toBe(Object.keys(CATEGORIES).length);
    await seedCategoryMemory(memory);
    const rows = await store.listMemory!({ kind: "semantic", source: "seed" });
    expect(rows.map((r) => r.id)).toEqual(Object.keys(CATEGORIES).map((id) => `mem_seed_${id}`));
    expect(rows[0]).toMatchObject({ chatId: null, category: "subway-delay", about: [{ table: "complaint_category", id: "subway-delay" }] });
    const hit = await memory.recall({ text: "where do subway delays get filed", kind: "semantic" });
    expect(hit[0]?.id).toBe("mem_seed_subway-delay");
  });
});
