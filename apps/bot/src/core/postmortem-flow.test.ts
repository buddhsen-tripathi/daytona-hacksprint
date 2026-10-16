/**
 * #13: the orchestrator fires the post-mortem AFTER the outcome message, never blocks/throws into it, and tells the
 * resident once when a required field was learned.
 */
import { describe, expect, it } from "vitest";
import type { Classifier, FilingOutcome, RepairDiagnosis } from "./contracts.js";
import { EMPTY_TRANSIT } from "./contracts.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createCaptureTransport } from "../api/capture-transport.js";
import { createBoundsLocationService, createNoopTracer, createUnavailableDuplicateService, type FilingService } from "../integrations/fallbacks.js";
import { crossStreet2Attempt } from "../services/__fixtures__/postmortem-attempt.js";
import type { Diagnoser } from "../services/postmortem.js";
import { createOrchestrator } from "./orchestrator.js";

const diagnosis: RepairDiagnosis = {
  cause: "missing_required_field",
  proposedChanges: [{ kind: "requiredField", before: null, after: "Cross Street 2", evidence: ["ev_validate_shot"] }],
  confidence: 0.95,
};

async function run(diagnoser: Diagnoser) {
  const store = createMemoryStore();
  const transport = createCaptureTransport();
  const classifier: Classifier = {
    async classify() {
      return {
        result: { rationale: "", alternativeConsidered: null, safetyFlags: [], clarifyingQuestion: null, triage: "SUPPORTED", category: "subway-delay", confidence: 0.92, description: "The A train was delayed.", transit: { ...EMPTY_TRANSIT, line: "A", direction: "Uptown", incidentTime: "2026-10-16T08:30:00-04:00" } },
        model: "fake",
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
  let outcomeSentAt = 0;
  let diagnosedAt = 0;
  const filing: FilingService = {
    async executeFiling(c) {
      await store.createAttempt({ ...crossStreet2Attempt, complaintId: c.id });
      return { complaintId: c.id, attemptId: crossStreet2Attempt.id, status: "HUMAN_ACTION_REQUIRED", errorCode: "UNEXPECTED_REQUIRED_FIELD", message: "the form needs Cross Street 2" } satisfies FilingOutcome;
    },
  };
  const wrapped: Diagnoser = async (ev) => {
    diagnosedAt = Date.now();
    outcomeSentAt = transport.messages.length;
    return diagnoser(ev);
  };
  const o = createOrchestrator({
    store, tracer: createNoopTracer(), classifier, location: createBoundsLocationService(), duplicates: createUnavailableDuplicateService(), filing, transport,
    mtaAlerts: async () => ({ alerts: [], fetchedAt: null, source: "mta" }), postmortem: { diagnoser: wrapped },
  });
  let n = 0;
  const ev = (e: Record<string, unknown>, waitForFiling = false) => o.handle({ chatId: "c1", updateId: `u${++n}`, username: null, ...e } as never, { waitForFiling });
  await ev({ kind: "text", text: "A train delayed, uptown at 8:30" });
  const approve = transport.messages.flatMap((m) => m.buttons ?? []).flat().find((b) => b.data?.startsWith("approve:"))!.data!;
  const before = transport.messages.length;
  await ev({ kind: "callback", data: approve, messageId: null }, true);
  const afterOutcome = transport.messages.length;
  await new Promise((r) => setTimeout(r, 50));
  return { store, transport, before, afterOutcome, outcomeSentAt, diagnosedAt };
}

describe("orchestrator → post-mortem (#13)", () => {
  it("runs after the outcome message, stores a proposal, and tells the resident once", async () => {
    const r = await run(async () => diagnosis);
    expect(r.diagnosedAt).toBeGreaterThan(0);
    expect(r.outcomeSentAt).toBeGreaterThan(r.before); // outcome already sent when the diagnosis ran
    const learned = r.transport.messages.filter((m) => /I learned something from this attempt/.test(m.text));
    expect(learned).toHaveLength(1);
    expect(learned[0]!.text).toContain("<b>Cross Street 2</b> up front");
    expect(await r.store.listRepairProposals!()).toHaveLength(1);
  });

  it("a failing diagnosis never reaches the resident or the outcome path", async () => {
    const r = await run(async () => {
      throw new Error("llm down");
    });
    expect(r.afterOutcome).toBeGreaterThan(r.before);
    expect(r.transport.messages.some((m) => /I learned something/.test(m.text))).toBe(false);
    expect(await r.store.listRepairProposals!()).toHaveLength(0);
  });
});
