/**
 * #12 question generation from learned required fields: mapping, ordering, phrasing (LLM once per label, cached as
 * semantic memory), deterministic fallback, buttons, answers.
 */
import { describe, expect, it, vi } from "vitest";
import type { ComplaintDraft, FormSchema, Resident } from "../core/contracts.js";
import { EMPTY_LOCATION } from "../core/contracts.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory } from "./agent-memory.js";
import {
  createFieldPhraser,
  directionOptionsFor,
  fallbackQuestion,
  fieldButtons,
  fieldPrompt,
  learnedFields,
  mapField,
  missingLearnedFields,
  parseFieldAnswer,
  parseFieldCallback,
  unknowableFields,
  type FieldRewriter,
} from "./field-questions.js";

const schema = (fields: FormSchema["steps"][number]["fields"], title = "Details"): FormSchema => ({ steps: [{ title, fields }], capturedAt: "2026-10-16T12:00:00Z" });
const draft = (over: Partial<ComplaintDraft> = {}): ComplaintDraft =>
  ({
    id: "cmp_t1",
    telegramChatId: "c",
    residentId: "r",
    status: "TRIAGING",
    category: "subway-delay",
    triage: "SUPPORTED",
    description: "The A train was held.",
    userMessages: [],
    location: { ...EMPTY_LOCATION },
    media: [],
    classification: null,
    transit: { line: "A", direction: "Downtown & Queens", station: null, borough: null, incidentTime: null, delayMinutes: null },
    missingFields: [],
    needsEmergencyReferral: false,
    confidence: 0.9,
    duplicates: [],
    duplicateReviewed: false,
    draftVersion: 1,
    approvedVersion: null,
    ...over,
  }) as ComplaintDraft;
const resident: Pick<Resident, "contactName" | "contactEmail"> = { contactName: null, contactEmail: null };

const LEARNED = schema([
  { label: "Which direction?", type: "button-choice", required: true, options: ["A Train-Uptown (Inwood-207 St)", "A Train-Downtown & Queens"], step: "Which direction?" },
  { label: "Car number", type: "text", required: true, step: "Additional Information" },
  { label: "Was the train crowded?", type: "radio", required: true, options: ["Yes", "No"], step: "Details" },
  { label: "Email (optional)", type: "text", required: false, step: "Contact details" },
]);

describe("learned fields → missing questions", () => {
  it("maps known labels onto intake fields and the rest onto extraFields, in form order", () => {
    expect(mapField("subway-delay", "Which direction?")).toEqual({ kind: "transit", key: "direction" });
    expect(mapField("subway-delay", "Select the line")).toEqual({ kind: "transit", key: "line" });
    expect(mapField("subway-delay", "Tell us more (Required)")).toEqual({ kind: "description" });
    expect(mapField("subway-delay", "Which service?")).toEqual({ kind: "adapter" });
    expect(mapField("subway-delay", "Email")).toEqual({ kind: "resident", key: "contactEmail" });
    expect(mapField("subway-delay", "Nearest cross street")).toEqual({ kind: "extra" });
    const f = learnedFields("subway-delay", LEARNED, ["Which direction?", "Car number", "Was the train crowded?"]);
    expect(f.map((x) => x.label)).toEqual(["Which direction?", "Car number", "Was the train crowded?"]); // optional email not asked
    const missing = missingLearnedFields(f, draft(), resident);
    expect(missing.map((x) => x.label)).toEqual(["Car number", "Was the train crowded?"]);
    expect(missingLearnedFields(f, draft({ extraFields: { "Car number": "4211" } }), resident).map((x) => x.label)).toEqual(["Was the train crowded?"]);
  });

  it("listed in requiredFields but optional on the form ⇒ asked, skippable; unknowable ⇒ never asked", () => {
    const s = schema([
      { label: "Nearest cross street", type: "text", required: false, step: "Where" },
      { label: "Account number", type: "text", required: true, step: "Where" },
    ]);
    const f = learnedFields("subway-delay", s, ["Nearest cross street"]);
    const [cross] = missingLearnedFields(f, draft(), resident);
    expect(cross).toMatchObject({ label: "Nearest cross street", required: false });
    expect(parseFieldAnswer(cross!, "skip")).toEqual({ kind: "skip" });
    expect(unknowableFields(f, draft()).map((x) => x.label)).toEqual(["Account number"]);
    expect(missingLearnedFields(f, draft(), resident).map((x) => x.label)).toEqual(["Nearest cross street"]);
  });

  it("direction options come from the learned schema for the same line, else the table", () => {
    expect(directionOptionsFor(LEARNED, "A")).toEqual(["Uptown (Inwood-207 St)", "Downtown & Queens"]);
    expect(directionOptionsFor(LEARNED, "7")).toEqual(["Queens (Flushing-Main St)", "Manhattan (34 St-Hudson Yards)"]); // learned for another line
    expect(directionOptionsFor(null, "A")).toEqual(["Uptown (Inwood-207 St)", "Downtown & Queens"]);
  });
});

describe("buttons + answers", () => {
  const f = learnedFields("subway-delay", LEARNED, null);
  const crowded = f.find((x) => x.label === "Was the train crowded?")!;
  const car = f.find((x) => x.label === "Car number")!;

  it("options render as set_field buttons; skip only for optional fields", () => {
    const rows = fieldButtons(draft(), crowded, "choice");
    expect(rows.map((r) => r[0]!.text)).toEqual(["Yes", "No"]);
    expect(rows[1]![0]!.data).toBe(`set_field:cmp_t1:1:${crowded.index}:1`);
    expect(parseFieldCallback(rows[1]![0]!.data!)).toEqual({ index: crowded.index, choice: 1 });
    expect(fieldButtons(draft(), car, "text")).toEqual([]);
    expect(fieldButtons(draft(), { ...car, required: false }, "text").flat().map((b) => b.text)).toEqual(["Skip (optional)"]);
    expect(fieldButtons(draft(), { ...car, type: "date" }, "date").flat().map((b) => b.text)).toEqual(["Today"]);
  });

  it("typed answers: option by text/number, required ⇒ no skip, why ⇒ explanation", () => {
    expect(parseFieldAnswer(crowded, "no")).toMatchObject({ kind: "invalid" }); // "no" reads as skip ⇒ required
    expect(parseFieldAnswer(crowded, "2")).toEqual({ kind: "value", value: "No" });
    expect(parseFieldAnswer(crowded, "yes")).toEqual({ kind: "value", value: "Yes" });
    expect(parseFieldAnswer(crowded, "maybe")).toMatchObject({ kind: "invalid" });
    expect(parseFieldAnswer(car, "skip")).toMatchObject({ kind: "invalid", message: expect.stringContaining("The official form requires it.") });
    expect(parseFieldAnswer(car, "why?")).toEqual({ kind: "why" });
    expect(parseFieldAnswer(car, " 4211 ")).toEqual({ kind: "value", value: "4211" });
    expect(parseFieldAnswer({ ...car, label: "Date Detected (MM/DD/YYYY)", type: "date" }, "today")).toMatchObject({ kind: "value", value: expect.stringMatching(/^\d{2}\/\d{2}\/\d{4}$/) });
  });

  it("prompt shows the official label and the plain question", () => {
    const p = fieldPrompt(car, { question: "What's the car number?", helper: "It's on the inside of the car." });
    expect(p).toContain("“Car number”");
    expect(p).toContain("<b>What's the car number?</b>");
    expect(p).not.toContain("skip");
  });
});

describe("phrasing: LLM once per label, cached as semantic memory", () => {
  it("LLM unavailable ⇒ deterministic fallback phrasing", async () => {
    const store = createMemoryStore();
    const p = createFieldPhraser({ store, memory: null, rewrite: null });
    const q = await p.phrase("subway-delay", { label: "Car number", type: "text" });
    expect(q).toMatchObject({ question: "The official form needs: Car number. What should I put?", kind: "text", source: "fallback" });
    expect(fallbackQuestion({ label: "Was the train crowded?", type: "radio", options: ["Yes", "No"] }).kind).toBe("choice");
    const failing: FieldRewriter = async () => {
      throw new Error("OPENROUTER_API_KEY is not set");
    };
    expect((await createFieldPhraser({ store, memory: null, rewrite: failing }).phrase("subway-delay", { label: "Car number", type: "text" })).source).toBe("fallback");
  });

  it("semantic cache hit ⇒ one LLM call across two phrasers (two drafts / restarts)", async () => {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    const rewrite = vi.fn<FieldRewriter>(async () => ({ question: "What's the number on the train car?", kind: "text", helper: "It's printed by the doors." }));
    const a = await createFieldPhraser({ store, memory, rewrite }).phrase("subway-delay", { label: "Car number", type: "text" });
    await memory.flush();
    const b = await createFieldPhraser({ store, memory, rewrite }).phrase("subway-delay", { label: "Car number", type: "text" });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ question: "What's the number on the train car?", source: "llm" });
    expect(b).toMatchObject({ question: "What's the number on the train car?", helper: "It's printed by the doors.", source: "memory" });
    const rows = await store.listMemory!({ kind: "semantic", category: "subway-delay" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ label: "Car number", question: "What's the number on the train car?" });
  });
});
