/**
 * #12 end to end through the orchestrator: a category with learned required fields asks exactly the missing ones,
 * in order, before the approval card; answers land in extraFields (version bump), on the card and in the payload.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClassificationResult, FormSchema, Resident, Store, TransitDetails } from "../core/contracts.js";
import { EMPTY_LOCATION } from "../core/contracts.js";
import { createOrchestrator } from "../core/orchestrator.js";
import { createCaptureTransport, type CapturedMessage } from "../api/capture-transport.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory } from "./agent-memory.js";
import { createFieldPhraser, type FieldPhraser, type FieldRewriter } from "./field-questions.js";
import { recordFormSchema, schemaMemoryId } from "./form-schema-memory.js";
import { buildForm } from "./filing.js";

const transit = (over: Partial<TransitDetails> = {}): TransitDetails => ({ line: "A", direction: "downtown", station: "14 St", borough: null, incidentTime: new Date().toISOString(), delayMinutes: 25, ...over });
const classification = (): ClassificationResult => ({
  triage: "SUPPORTED",
  category: "subway-delay",
  confidence: 0.95,
  description: "The A train was held at 14 St for 25 minutes.",
  rationale: "",
  alternativeConsidered: null,
  safetyFlags: [],
  clarifyingQuestion: null,
  transit: transit(),
});

/** 3 learned required fields; the draft already has the direction ⇒ 2 questions (car number, then crowded). */
const LEARNED: FormSchema = {
  steps: [
    { title: "Which direction?", fields: [{ label: "Which direction?", type: "button-choice", required: true, options: ["A Train-Uptown (Inwood-207 St)", "A Train-Downtown & Queens"], step: "Which direction?" }] },
    { title: "Additional Information", fields: [{ label: "Car number", type: "text", required: true, step: "Additional Information" }] },
    { title: "Tell us more", fields: [{ label: "Was the train crowded?", type: "radio", required: true, options: ["Yes", "No"], step: "Tell us more" }] },
  ],
  capturedAt: "2026-10-16T12:00:00Z",
};

/** What #11 writes after a filing run (procedural memory `mem_schema_<category>` + catalog row). */
async function seed(store: Store, schema: FormSchema) {
  const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
  await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: { id: `att_${Math.random().toString(36).slice(2, 8)}`, traceId: null }, outcome: "HUMAN_ACTION_REQUIRED", formSchema: schema });
  await memory.flush();
}

/** A learned requiredFields list that also names a field the form marks optional (e.g. a human-approved repair, #13). */
async function seedRaw(store: Store, schema: FormSchema, requiredFields: string[]) {
  const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
  await memory.remember({
    id: schemaMemoryId("subway-delay"),
    kind: "procedural",
    text: "Form schema for Subway delay",
    category: "subway-delay",
    chatId: null,
    data: { formSchema: schema, requiredFields, version: 1, current: true },
    source: "seed",
    about: [{ table: "complaint_category", id: "subway-delay" }],
  });
  await memory.flush();
}

function harness(store: Store, fieldPhraser?: FieldPhraser) {
  const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
  const transport = createCaptureTransport();
  const orch = createOrchestrator({
    store,
    memory,
    tracer: createNoopTracer(),
    classifier: { classify: async () => ({ result: classification(), model: "stub", usage: { promptTokens: null, completionTokens: null } }) },
    location: { fromPin: async () => ({ ...EMPTY_LOCATION }), fromText: async () => null, withinNyc: () => true },
    duplicates: { findPotentialDuplicates: async () => ({ candidates: [], dataAsOf: null, source: "open-data" }), lookupStatus: async () => null },
    filing: { executeFiling: async () => ({ complaintId: "x", attemptId: "none", status: "FAILED", errorCode: "SANDBOX_ERROR", message: "stub" }) },
    transport,
    mtaAlerts: async () => ({ alerts: [], source: "unavailable" }) as never,
    ...(fieldPhraser ? { fieldPhraser } : {}),
  });
  let n = 0;
  const hid = Math.random().toString(36).slice(2, 8);
  const say = async (chatId: string, text: string) => {
    const before = transport.messages.length;
    await orch.handle({ kind: "text", chatId, updateId: `${hid}-${++n}`, text, username: null });
    await memory.flush();
    return transport.messages.slice(before);
  };
  const tap = async (chatId: string, data: string) => {
    const before = transport.messages.length;
    await orch.handle({ kind: "callback", chatId, updateId: `${hid}-${++n}`, data, messageId: null, username: null });
    await memory.flush();
    return transport.messages.slice(before);
  };
  return { memory, say, tap };
}

const last = (msgs: CapturedMessage[]) => msgs[msgs.length - 1]!;
const buttons = (m: CapturedMessage) => (m.buttons ?? []).flat();
const isCard = (m: CapturedMessage) => buttons(m).some((b) => b.data?.startsWith("approve:"));
const REPORT = "The A train was held at 14 St for 25 minutes, downtown";
const rewriter = () =>
  vi.fn<FieldRewriter>(async ({ label }) =>
    label === "Car number" ? { question: "What's the number on the train car?", kind: "text", helper: "It's printed inside, by the doors." } : { question: "Was the train crowded?", kind: "choice", helper: null },
  );

describe("#12 learned required fields → questions before approval", () => {
  it("3 learned required fields, draft missing 2 → exactly 2 questions in order; answers in extraFields, card, payload", async () => {
    const store = createMemoryStore();
    await seed(store, LEARNED);
    const rewrite = rewriter();
    const h = harness(store, createFieldPhraser({ store, memory: null, rewrite }));
    const chat = "rider-12a";

    const q1 = last(await h.say(chat, REPORT));
    expect(isCard(q1)).toBe(false);
    expect(q1.text).toContain("“Car number”");
    expect(q1.text).toContain("What's the number on the train car?");
    expect(buttons(q1)).toEqual([]); // free text, required ⇒ no skip button
    const v1 = (await store.getActiveComplaint(chat))!;
    expect(v1.statusReason).toBe("missing: form field:Car number");

    // required ⇒ skip refused; "why?" ⇒ the reason + the same question
    expect(last(await h.say(chat, "skip")).text).toContain("The official form requires it.");
    const why = last(await h.say(chat, "why?"));
    expect(why.text).toMatch(/^The official form requires it\./);
    expect(why.text).toContain("What's the number on the train car?");

    const q2 = last(await h.say(chat, "4211"));
    expect(q2.text).toContain("Got it: <b>4211</b>.");
    expect(q2.text).toContain("Was the train crowded?");
    const v2 = (await store.getActiveComplaint(chat))!;
    expect(v2.extraFields).toEqual({ "Car number": "4211" });
    expect(v2.draftVersion).toBe(v1.draftVersion + 1);
    // options render as buttons
    expect(buttons(q2).map((b) => b.text)).toEqual(["Yes", "No"]);
    const yes = buttons(q2)[0]!.data!;
    expect(yes).toMatch(/^set_field:/);

    const card = last(await h.tap(chat, yes));
    expect(isCard(card)).toBe(true);
    expect(card.text).toContain("<b>What the form needs:</b>");
    expect(card.text).toContain("• Car number: 4211");
    expect(card.text).toContain("• Was the train crowded?: Yes");
    const done = (await store.getActiveComplaint(chat))!;
    expect(done.status).toBe("READY_FOR_APPROVAL");
    expect(done.extraFields).toEqual({ "Car number": "4211", "Was the train crowded?": "Yes" });
    expect(done.transit?.direction).toBe("Downtown & Queens"); // resolved against the learned options
    const resident = { contactName: null, contactEmail: null } as Resident;
    expect(buildForm(done, resident).extraFields).toEqual({ "Car number": "4211", "Was the train crowded?": "Yes" });
    expect(rewrite).toHaveBeenCalledTimes(2); // one per label
  });

  it("semantic cache: a second draft (fresh bot process) asks the same questions with no new LLM call", async () => {
    const store = createMemoryStore();
    await seed(store, LEARNED);
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    const rewrite = rewriter();
    const a = harness(store, createFieldPhraser({ store, memory, rewrite }));
    expect(last(await a.say("rider-12b", REPORT)).text).toContain("What's the number on the train car?");
    await memory.flush();
    const b = harness(store, createFieldPhraser({ store, memory, rewrite }));
    expect(last(await b.say("rider-12c", REPORT)).text).toContain("What's the number on the train car?");
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it("LLM unavailable ⇒ deterministic fallback phrasing", async () => {
    const store = createMemoryStore();
    await seed(store, LEARNED);
    const h = harness(store, createFieldPhraser({ store, memory: null, rewrite: null }));
    expect(last(await h.say("rider-12d", REPORT)).text).toContain("The official form needs: Car number. What should I put?");
  });

  it("skip only for optional fields: an optional learned field gets a skip button and is not re-asked", async () => {
    const store = createMemoryStore();
    await seedRaw(store, { steps: [{ title: "Details", fields: [{ label: "Nearest cross street", type: "text", required: false, step: "Details" }] }], capturedAt: "2026-10-16T12:00:00Z" }, ["Nearest cross street"]);
    const h = harness(store, createFieldPhraser({ store, memory: null, rewrite: null }));
    const chat = "rider-12g";
    const q = last(await h.say(chat, REPORT));
    expect(q.text).toContain("“Nearest cross street”");
    expect(q.text).toContain("or “skip” (it's optional)");
    expect(buttons(q).map((b) => b.text)).toEqual(["Skip (optional)"]);
    const card = last(await h.say(chat, "skip"));
    expect(card.text).toContain("OK, I'll leave that out.");
    expect(isCard(card)).toBe(true);
    expect((await store.getActiveComplaint(chat))!.extraFields ?? {}).toEqual({});
  });

  it("unknowable required fields are announced and handed off, never asked or filled", async () => {
    const store = createMemoryStore();
    await seed(store, { steps: [{ title: "Details", fields: [{ label: "Account number", type: "text", required: true, step: "Details" }] }], capturedAt: "2026-10-16T12:00:00Z" });
    const h = harness(store, createFieldPhraser({ store, memory: null, rewrite: null }));
    const chat = "rider-12e";
    const card = last(await h.say(chat, REPORT));
    expect(isCard(card)).toBe(true);
    expect(card.text).toContain("The official form also needs “Account number”");
    expect(card.text).toContain("hand you the official form");
    expect(card.text).toContain("• Account number: <i>you'll enter this yourself on the official form</i>");
    expect((await store.getActiveComplaint(chat))!.extraFields ?? {}).toEqual({});
  });

  it("no learned schema ⇒ straight to the card, unchanged (no 'What the form needs')", async () => {
    const store = createMemoryStore();
    const h = harness(store, createFieldPhraser({ store, memory: null, rewrite: null }));
    const card = last(await h.say("rider-12f", REPORT));
    expect(isCard(card)).toBe(true);
    expect(card.text).not.toContain("What the form needs");
  });
});
