import { describe, expect, it } from "vitest";
import type { RepairDiagnosis } from "../core/contracts.js";
import { crossStreet2Attempt } from "./__fixtures__/postmortem-attempt.js";
import { autoApplicableChanges, decideProposal, diagnose, gatherEvidence, isAutoApplicable, shouldPostmortem } from "./postmortem.js";

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

  it("gathers evidence ids, events and the form_schema from events", () => {
    const ev = gatherEvidence(crossStreet2Attempt);
    expect(ev.evidence.map((e) => e.id)).toEqual(["ev_validate_shot", "ev_schema_json"]);
    expect(ev.formSchema?.fields.map((f) => f.label)).toContain("Cross Street 2");
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
