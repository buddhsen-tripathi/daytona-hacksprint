import { describe, expect, it } from "vitest";
import type { ClassificationResult, Classifier, FilingOutcome, TransitDetails, WorkerAnswer, WorkerEvent, WorkerQuestion } from "./contracts.js";
import { EMPTY_TRANSIT, decodeCallback, questionFromEvent } from "./contracts.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { answerFile, workerDeadline } from "../integrations/local-sandbox.js";
import { capturedQuestions, createCaptureTransport } from "../api/capture-transport.js";
import { createBoundsLocationService, createNoopTracer, createUnavailableDuplicateService, type FilingService } from "../integrations/fallbacks.js";
import { createOrchestrator } from "./orchestrator.js";

const T = (p: Partial<TransitDetails>): TransitDetails => ({ ...EMPTY_TRANSIT, ...p });
const subway = (transit: TransitDetails): ClassificationResult => ({
  rationale: "",
  alternativeConsidered: null,
  safetyFlags: [],
  clarifyingQuestion: null,
  triage: "SUPPORTED",
  category: "subway-delay",
  confidence: 0.92,
  description: "The A train was delayed.",
  transit,
});
const Q: WorkerQuestion = { id: "direction", field: "direction", prompt: "Which way was the A train going?", options: ["Uptown (Inwood-207 St)", "Downtown & Queens"], required: true };
const qEvent = (question: unknown): WorkerEvent => ({ ts: new Date().toISOString(), step: "fill", level: "warn", message: "question", data: { question } });

describe("worker question protocol", () => {
  it("recognizes question events only", () => {
    expect(questionFromEvent(qEvent(Q))).toEqual(Q);
    expect(questionFromEvent({ ...qEvent(Q), message: "step fill started" })).toBeNull();
    expect(questionFromEvent(qEvent({ ...Q, id: "../etc" }))).toBeNull();
  });
  it("answer files refuse path-like ids", () => {
    expect(answerFile("direction", { value: "Downtown & Queens", optionIndex: 1 })).toEqual({ name: "answer-direction.json", body: '{"value":"Downtown & Queens","optionIndex":1}' });
    expect(() => answerFile("../x", { value: "a" })).toThrow();
  });
  it("extends the bot-side deadline for each question", () => {
    const d = workerDeadline({ limits: { totalTimeoutMs: 10_000, stepTimeoutMs: 1, maxNavigationRetries: 0, questionTimeoutMs: 60_000 } } as never);
    const before = d.at;
    const seen: WorkerEvent[] = [];
    const on = d.wrap((e) => seen.push(e));
    on({ ...qEvent(Q), message: "other" });
    expect(d.at).toBe(before);
    on(qEvent(Q));
    expect(d.at).toBe(before + 65_000);
    expect(seen).toHaveLength(2);
  });
  it("encodes answers as answer_q callbacks", () => {
    expect(decodeCallback("answer_q:cmp_x:2:direction:1")).toEqual({ action: "answer_q", complaintId: "cmp_x", version: 2 });
  });
});

describe("orchestrator: live question during filing", () => {
  async function setup() {
    const store = createMemoryStore();
    const transport = createCaptureTransport();
    const classifier: Classifier = {
      async classify() {
        return { result: subway(T({ line: "A", direction: "Manhattan-bound", incidentTime: "2026-10-16T08:30:00-04:00" })), model: "fake", usage: { promptTokens: null, completionTokens: null } };
      },
    };
    const answers: (WorkerAnswer | null)[] = [];
    const filing: FilingService = {
      async executeFiling(c, opts) {
        const a = await opts.onQuestion!({ ...Q, attemptId: "att_1", timeoutMs: 5_000 });
        answers.push(a);
        return { complaintId: c.id, attemptId: "att_1", status: "FAILED", errorCode: "BROWSER_ERROR", message: "stop here" } satisfies FilingOutcome;
      },
    };
    const o = createOrchestrator({ store, tracer: createNoopTracer(), classifier, location: createBoundsLocationService(), duplicates: createUnavailableDuplicateService(), filing, transport, mtaAlerts: async () => ({ alerts: [], fetchedAt: null, source: "mta" }), directionDuringFiling: true });
    let n = 0;
    const ev = (e: Record<string, unknown>, waitForFiling = false) => o.handle({ chatId: "c1", updateId: `u${++n}`, username: null, ...e } as never, { waitForFiling });
    await ev({ kind: "text", text: "A train delayed, Manhattan-bound at 8:30" });
    const approve = transport.messages.flatMap((m) => m.buttons ?? []).flat().find((b) => b.data?.startsWith("approve:"))!.data!;
    return { o, transport, answers, ev, approve };
  }

  it("leaves an unresolved direction for the worker, sends buttons, and resolves on tap while the filing job holds the chat queue", async () => {
    const { transport, answers, ev, approve } = await setup();
    expect(transport.messages.some((m) => m.buttons?.flat().some((b) => b.data?.startsWith("set_direction:")))).toBe(false);
    const job = ev({ kind: "callback", data: approve, messageId: null }, true); // awaits filing inside the chat queue
    await new Promise((r) => setTimeout(r, 50));
    const q = capturedQuestions(transport.messages);
    expect(q).toHaveLength(1);
    expect(q[0]!.options.map((x) => x.text)).toEqual(Q.options);
    expect(q[0]!.options[1]!.data).toMatch(/^answer_q:cmp_[a-z0-9]+:\d+:direction:1$/);
    await ev({ kind: "callback", data: q[0]!.options[1]!.data, messageId: null });
    await job;
    expect(answers).toEqual([{ value: "Downtown & Queens", optionIndex: 1 }]);
    expect(transport.messages.some((m) => /Got it: <b>Downtown &amp; Queens<\/b>/.test(m.text))).toBe(true);
  });

  it("a typed answer while a question is pending answers it", async () => {
    const { o, answers, ev, approve } = await setup();
    const job = ev({ kind: "callback", data: approve, messageId: null }, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(o.pendingQuestions("c1")).toHaveLength(1);
    await ev({ kind: "text", text: "uptown" });
    await job;
    expect(answers).toEqual([{ value: "uptown" }]);
    expect(o.pendingQuestions("c1")).toHaveLength(0);
  });
});
