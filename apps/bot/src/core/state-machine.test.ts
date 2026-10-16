import { describe, expect, it } from "vitest";
import type { ComplaintDraft } from "./contracts.js";
import { EMPTY_TRANSIT } from "./contracts.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createComplaintService } from "../services/complaints.js";
import { IllegalTransitionError, applyTransition, bumpDraft, transition } from "./state-machine.js";
import { isMaterialChange, missingFields } from "./knowledge.js";

async function readyDraft() {
  const store = createMemoryStore();
  const svc = createComplaintService(store);
  let d = await svc.newDraft("chat1", "res1");
  d = { ...d, category: "subway-delay", description: "The A train was held at 14 St for 25 minutes.", transit: { ...EMPTY_TRANSIT, line: "A", direction: "Downtown & Queens", station: "14 St" } };
  d = await transition(store, d, "TRIAGING", { reason: "t", actor: "system" });
  d = await transition(store, d, "READY_FOR_APPROVAL", { reason: "t", actor: "system" });
  return { store, svc, d };
}

describe("state machine", () => {
  it("rejects illegal transitions", async () => {
    const store = createMemoryStore();
    const d = await createComplaintService(store).newDraft("c", "r");
    await expect(transition(store, d, "FILING", { reason: "x", actor: "system" })).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(transition(store, d, "SUBMITTED", { reason: "x", actor: "user" })).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("records transitions and bumps updatedAt", async () => {
    const { store, d } = await readyDraft();
    expect(d.status).toBe("READY_FOR_APPROVAL");
    expect(store.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["RECEIVED->TRIAGING", "TRIAGING->READY_FOR_APPROVAL"]);
  });

  it("LLM and system actors cannot approve", async () => {
    const { store, d } = await readyDraft();
    const stamped: ComplaintDraft = { ...d, approvedVersion: d.draftVersion };
    await expect(transition(store, stamped, "APPROVED", { reason: "llm says go", actor: "llm" })).rejects.toThrow(/requires a user action/);
    await expect(transition(store, stamped, "APPROVED", { reason: "timer", actor: "system" })).rejects.toThrow(/requires a user action/);
  });

  it("system cannot skip duplicate review", async () => {
    const { store } = await readyDraft();
    const d = await createComplaintService(store).newDraft("c2", "r");
    let x = await transition(store, d, "TRIAGING", { reason: "t", actor: "system" });
    x = await transition(store, x, "DUPLICATE_REVIEW", { reason: "dups", actor: "system" });
    await expect(transition(store, x, "READY_FOR_APPROVAL", { reason: "skip", actor: "llm" })).rejects.toThrow(/requires a user action/);
    const ok = await transition(store, x, "READY_FOR_APPROVAL", { reason: "continue", actor: "user" });
    expect(ok.status).toBe("READY_FOR_APPROVAL");
  });

  it("user can approve the exact version", async () => {
    const { svc, d } = await readyDraft();
    const r = await svc.approve(d, d.draftVersion, "user");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.status).toBe("APPROVED");
      expect(r.draft.approvedVersion).toBe(d.draftVersion);
      expect(r.draft.approvedAt).not.toBeNull();
    }
  });

  it("rejects approval for a stale version", async () => {
    const { svc, store, d } = await readyDraft();
    const changed = await store.saveComplaint(svc.setDescription(d, "A different train: the C was held at Jay St for 15 minutes."));
    expect(changed.draftVersion).toBe(d.draftVersion + 1);
    const r = await svc.approve(changed, d.draftVersion, "user");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("VERSION_MISMATCH");
    expect(() => applyTransition({ ...changed, approvedVersion: d.draftVersion }, "APPROVED", { reason: "x", actor: "user" })).toThrow(/version mismatch/i);
  });

  it("non-user approval via service is refused", async () => {
    const { svc, d } = await readyDraft();
    const r = await svc.approve(d, d.draftVersion, "llm");
    expect(r.ok).toBe(false);
  });

  it("bumpDraft clears approval", async () => {
    const { svc, d } = await readyDraft();
    const r = await svc.approve(d, d.draftVersion, "user");
    if (!r.ok) throw new Error("expected approval");
    const b = bumpDraft(r.draft);
    expect(b.draftVersion).toBe(d.draftVersion + 1);
    expect(b.approvedVersion).toBeNull();
    expect(() => applyTransition(b, "FILING", { reason: "x", actor: "system" })).toThrow();
  });
});

describe("knowledge", () => {
  it("material change rule", async () => {
    const { d } = await readyDraft();
    expect(isMaterialChange(d, { ...d, userMessages: ["hi"] })).toBe(false);
    expect(isMaterialChange(d, { ...d, category: null })).toBe(true);
    expect(isMaterialChange(d, { ...d, transit: { ...d.transit!, line: "C" } })).toBe(true);
    expect(isMaterialChange(d, { ...d, location: { ...d.location, latitude: 40.7 } })).toBe(true);
  });
  it("missing fields", async () => {
    const { d } = await readyDraft();
    expect(missingFields(d)).toEqual([]);
    expect(missingFields({ ...d, transit: { ...d.transit!, direction: null } })).toEqual(["transit"]);
  });
});

describe("classification application", () => {
  it("low confidence ⇒ clarify; invalid category rejected", async () => {
    const store = createMemoryStore();
    const svc = createComplaintService(store);
    const d = await svc.newDraft("c", "r");
    const base = { description: "hole", rationale: "", alternativeConsidered: null, safetyFlags: [], clarifyingQuestion: "Is it in the road?" };
    expect(svc.applyClassification(d, { ...base, triage: "SUPPORTED", category: "subway-delay", confidence: 0.4 }).decision.kind).toBe("CLARIFY");
    const bad = svc.applyClassification(d, { ...base, triage: "SUPPORTED", category: "noise" as never, confidence: 0.9 });
    expect(bad.decision.kind).toBe("CLARIFY");
    expect(bad.draft.category).toBeNull();
    const good = svc.applyClassification(d, { ...base, triage: "SUPPORTED", category: "subway-delay", confidence: 0.9 });
    expect(good.decision.kind).toBe("CONTINUE");
    expect(good.draft.category).toBe("subway-delay");
  });
});
