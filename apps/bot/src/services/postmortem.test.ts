import { describe, expect, it } from "vitest";
import type { RepairDiagnosis } from "../core/contracts.js";
import { crossStreet2Attempt } from "./__fixtures__/postmortem-attempt.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory } from "./agent-memory.js";
import { readCurrentSchema } from "./form-schema-memory.js";
import { RECIPES_UNAVAILABLE, applicability, autoApplicableChanges, decideAndApply, decideProposal, diagnose, gatherEvidence, isAutoApplicable, runPostmortem, shouldPostmortem, withRequiredFields } from "./postmortem.js";

const stub = (d: RepairDiagnosis) => async () => d;
const crossStreet2: RepairDiagnosis = {
  cause: "missing_required_field",
  proposedChanges: [{ kind: "requiredField", before: null, after: "Cross Street 2", evidence: ["ev_validate_shot", "ev_schema_json"] }],
  confidence: 0.95,
};

describe("postmortem (#13)", () => {
  it("triggers on the issue's outcomes and on live questions only", () => {
    expect(shouldPostmortem(crossStreet2Attempt)).toBe(true);
    expect(shouldPostmortem({ ...crossStreet2Attempt, outcome: "SUBMISSION_UNKNOWN", errorCode: "NO_CONFIRMATION" })).toBe(true);
    expect(shouldPostmortem({ ...crossStreet2Attempt, outcome: "FAILED", errorCode: "FORM_REJECTED" })).toBe(true);
    const clean = { ...crossStreet2Attempt, outcome: "SUBMITTED" as const, errorCode: null, workerEvents: [] };
    expect(shouldPostmortem(clean)).toBe(false);
    expect(shouldPostmortem({ ...clean, outcome: "FAILED", errorCode: "CAPTCHA" })).toBe(false);
    expect(shouldPostmortem({ ...clean, workerEvents: [{ ts: "t", step: "fill", level: "info", message: "question" }] })).toBe(true);
  });

  it("a dry-run stop (HUMAN_ACTION_REQUIRED, no error code) never triggers, even after a live question", () => {
    const dry = { ...crossStreet2Attempt, outcome: "HUMAN_ACTION_REQUIRED" as const, errorCode: null };
    expect(shouldPostmortem({ ...dry, workerEvents: [] })).toBe(false);
    expect(shouldPostmortem({ ...dry, workerEvents: [{ ts: "t", step: "fill", level: "info", message: "question" }] })).toBe(false);
  });

  it("gathers evidence ids, events and the form_schema from events", () => {
    const ev = gatherEvidence(crossStreet2Attempt);
    expect(ev.evidence.map((e) => e.id)).toEqual(["ev_validate_shot", "ev_schema_json"]);
    expect(ev.formSchema?.steps.flatMap((s) => s.fields.map((f) => f.label))).toContain("Cross Street 2");
    expect(ev.traceId).toBe("trace_fixture1");
  });

  it("stubbed diagnosis yields a pending requiredField proposal with evidence ids", async () => {
    const p = await diagnose(crossStreet2Attempt, { diagnoser: stub(crossStreet2) });
    expect(p.status).toBe("pending");
    expect(p.attemptId).toBe("att_fixture1");
    expect(p.cause).toBe("missing_required_field");
    expect(p.proposedChanges[0]).toMatchObject({ kind: "requiredField", after: "Cross Street 2" });
    expect(p.proposedChanges[0]!.evidence).toEqual(["ev_validate_shot", "ev_schema_json"]);
  });

  it("drops invented evidence ids and changes left with no evidence", async () => {
    const p = await diagnose(crossStreet2Attempt, {
      diagnoser: stub({ ...crossStreet2, proposedChanges: [{ ...crossStreet2.proposedChanges[0]!, evidence: ["ev_made_up"] }] }),
    });
    expect(p.proposedChanges).toHaveLength(0);
  });

  it("auto-apply guard: only requiredField additions at confidence >= 0.9", async () => {
    const p = await diagnose(crossStreet2Attempt, { diagnoser: stub(crossStreet2) });
    expect(autoApplicableChanges(p)).toHaveLength(1);
    expect(autoApplicableChanges({ ...p, confidence: 0.89 })).toHaveLength(0);
    const ev = ["ev_validate_shot"];
    expect(isAutoApplicable({ confidence: 1 }, { kind: "recipeStep", before: null, after: "click next", evidence: ev })).toBe(false);
    expect(isAutoApplicable({ confidence: 1 }, { kind: "confirmRegex", before: "a", after: "b", evidence: ev })).toBe(false);
    expect(isAutoApplicable({ confidence: 1 }, { kind: "requiredField", before: "Cross St", after: "Cross Street 2", evidence: ev })).toBe(false);
    expect(isAutoApplicable({ confidence: 1 }, { kind: "requiredField", before: null, after: "X", evidence: [] })).toBe(false);
  });

  it("approve/reject is one-shot", async () => {
    const p = await diagnose(crossStreet2Attempt, { diagnoser: stub(crossStreet2) });
    const a = decideProposal(p, "approved", new Date("2026-10-16T13:00:00Z"));
    expect(a.status).toBe("approved");
    expect(a.decidedAt).toBe("2026-10-16T13:00:00.000Z");
    expect(() => decideProposal(a, "rejected")).toThrow();
  });
});

describe("postmortem job + store + apply (#13)", () => {
  async function setup() {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    await store.createAttempt(crossStreet2Attempt);
    return { store, memory };
  }

  it("high-confidence requiredField: stored, auto-applied via #11 schema path, resident gets 'ask up front'", async () => {
    const { store, memory } = await setup();
    const r = await runPostmortem({ store, memory, diagnoser: stub(crossStreet2) }, crossStreet2Attempt.id);
    expect(r?.askUpFront).toEqual(["Cross Street 2"]);
    expect(r?.proposal).toMatchObject({ status: "approved", decidedBy: "auto", applied: ["Cross Street 2"] });
    expect(await store.getRepairProposal!(r!.proposal.id)).toMatchObject({ status: "approved" });
    await memory.flush();
    const cur = await readCurrentSchema(store, "subway-delay");
    expect(cur?.requiredFields).toContain("Cross Street 2");
    // one proposal per attempt
    expect(await runPostmortem({ store, memory, diagnoser: stub(crossStreet2) }, crossStreet2Attempt.id)).toBeNull();
    // a reflect() note was written
    const rows = await store.listMemory!({ limit: 100 });
    expect(rows.some((m) => /Post-mortem/.test(m.text))).toBe(true);
  });

  it("low confidence stays pending; operator approve applies requiredField and bumps lastVerifiedAt; reject applies nothing", async () => {
    const { store, memory } = await setup();
    const r = await runPostmortem({ store, memory, diagnoser: stub({ ...crossStreet2, confidence: 0.6 }) }, crossStreet2Attempt.id);
    expect(r?.askUpFront).toEqual([]);
    expect(r?.proposal.status).toBe("pending");
    expect(await readCurrentSchema(store, "subway-delay")).toBeNull();
    expect(await store.listRepairProposals!({ status: "pending" })).toHaveLength(1);

    const now = new Date("2026-10-16T14:00:00Z");
    const approved = await decideAndApply({ store, memory }, r!.proposal, "approved", now);
    expect(approved).toMatchObject({ status: "approved", decidedBy: "operator", applied: ["Cross Street 2"] });
    await memory.flush();
    const cur = await readCurrentSchema(store, "subway-delay");
    expect(cur?.requiredFields).toContain("Cross Street 2");
    expect(cur?.formSchema.capturedAt).toBe(now.toISOString());
    await expect(decideAndApply({ store, memory }, approved, "rejected")).rejects.toThrow();

    const rejected = await decideAndApply({ store }, { ...r!.proposal, id: "rep_other" }, "rejected");
    expect(rejected.applied).toEqual([]);
  });

  it("confirmRegex / questionText: never auto-applied; approve writes them to the category row; recipeStep stays applyable:false", async () => {
    const { store } = await setup();
    const annotations: { traceId: string; name: string; label?: string }[] = [];
    const annotate = async (traceId: string, a: { name: string; label?: string }) => (annotations.push({ traceId, name: a.name, label: a.label }), true);
    const ev = ["ev_validate_shot"];
    const r = await runPostmortem(
      {
        store,
        annotate,
        diagnoser: stub({
          cause: "confirmation_pattern",
          confidence: 0.99,
          proposedChanges: [
            { kind: "confirmRegex", before: null, after: "Reference (?:#|number)\\s*(\\d{6,})", evidence: ev },
            { kind: "questionText", before: "Cross Street 2", after: "What's the other cross street nearest the station?", evidence: ev },
            { kind: "recipeStep", before: null, after: "click 'Next' after the location step", evidence: ev },
            { kind: "confirmRegex", before: null, after: "([unclosed", evidence: ev },
          ],
        }),
      },
      crossStreet2Attempt.id,
    );
    expect(r?.proposal.status).toBe("pending");
    expect(r?.askUpFront).toEqual([]);
    expect(r!.proposal.proposedChanges.map((c) => [c.kind, c.applyable, c.reason])).toEqual([
      ["confirmRegex", true, null],
      ["questionText", true, null],
      ["recipeStep", false, RECIPES_UNAVAILABLE],
      ["confirmRegex", false, "invalid regex"],
    ]);
    expect(await store.getCategoryOverrides!("subway-delay")).toBeNull();

    const approved = await decideAndApply({ store, annotate }, r!.proposal, "approved");
    expect(approved.applied).toEqual([]);
    expect(approved.appliedOverrides).toEqual(["confirmRegex", "questionText:Cross Street 2"]);
    expect(await store.getCategoryOverrides!("subway-delay")).toMatchObject({
      confirmRegex: "Reference (?:#|number)\\s*(\\d{6,})",
      questionTexts: { "Cross Street 2": "What's the other cross street nearest the station?" },
      repairIds: [r!.proposal.id],
    });
    expect(await readCurrentSchema(store, "subway-delay")).toBeNull();
    // before (diagnosis) + after (decision) on the failing attempt's trace
    await new Promise((res) => setImmediate(res));
    expect(annotations).toEqual([
      { traceId: "trace_fixture1", name: "postmortem.diagnosis", label: "confirmation_pattern" },
      { traceId: "trace_fixture1", name: "postmortem.repair", label: "approved" },
    ]);
  });

  it("applicability: recipes unavailable, regex must compile, questionText needs the label", () => {
    const ev = ["e"];
    expect(applicability({ kind: "recipeStep", before: null, after: "x", evidence: ev })).toEqual({ applyable: false, reason: RECIPES_UNAVAILABLE });
    expect(applicability({ kind: "confirmRegex", before: null, after: "(", evidence: ev }).applyable).toBe(false);
    expect(applicability({ kind: "questionText", before: null, after: "q?", evidence: ev }).applyable).toBe(false);
    expect(applicability({ kind: "requiredField", before: null, after: "Cross Street 2", evidence: ev })).toEqual({ applyable: true, reason: null });
  });

  it("never throws; skips attempts that don't qualify", async () => {
    const { store } = await setup();
    await store.saveAttempt({ ...crossStreet2Attempt, id: "att_ok", outcome: "SUBMITTED", errorCode: null, workerEvents: [] });
    expect(await runPostmortem({ store, diagnoser: stub(crossStreet2) }, "att_ok")).toBeNull();
    expect(await runPostmortem({ store, diagnoser: async () => { throw new Error("llm down"); } }, crossStreet2Attempt.id)).toBeNull();
  });

  it("withRequiredFields marks known fields and appends unknown ones", () => {
    const s = withRequiredFields({ steps: [{ title: "Where", fields: [{ label: "Cross Street 2", type: "text", required: false, step: "Where" }] }], capturedAt: "x" }, ["cross street 2", "Floor"], "t");
    expect(s.steps[0]!.fields[0]!.required).toBe(true);
    expect(s.steps[1]).toMatchObject({ title: "Learned from post-mortem", fields: [{ label: "Floor", required: true }] });
    expect(s.capturedAt).toBe("t");
  });
});
