/**
 * The only code allowed to change ComplaintDraft.status.
 * Enforces TRANSITIONS and USER_GATED (design doc §8.3): no LLM/system actor
 * can approve a draft or skip duplicate review.
 */
import type { ComplaintDraft, ComplaintState, Store } from "./contracts.js";
import { TRANSITIONS, USER_GATED, nowIso } from "./contracts.js";

export type Actor = "user" | "system" | "llm";

export class IllegalTransitionError extends Error {
  constructor(public from: ComplaintState, public to: ComplaintState, why: string) {
    super(`Illegal transition ${from} -> ${to}: ${why}`);
    this.name = "IllegalTransitionError";
  }
}

export class VersionMismatchError extends Error {
  constructor(public expected: number, public got: number) {
    super(`Draft version mismatch: current ${expected}, approval for ${got}`);
    this.name = "VersionMismatchError";
  }
}

export function canTransition(from: ComplaintState, to: ComplaintState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isUserGated(from: ComplaintState, to: ComplaintState): boolean {
  return (USER_GATED as readonly string[]).includes(`${from}->${to}`);
}

/** Validates and applies a transition in memory (no persistence). */
export function applyTransition(complaint: ComplaintDraft, to: ComplaintState, opts: { reason: string; actor: Actor }): ComplaintDraft {
  const from = complaint.status;
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, "not in TRANSITIONS");
  if (isUserGated(from, to) && opts.actor !== "user") {
    throw new IllegalTransitionError(from, to, `requires a user action (actor was ${opts.actor})`);
  }
  if (to === "APPROVED") {
    if (complaint.approvedVersion == null) throw new IllegalTransitionError(from, to, "approvedVersion not set");
    if (complaint.approvedVersion !== complaint.draftVersion) throw new VersionMismatchError(complaint.draftVersion, complaint.approvedVersion);
  }
  if (to === "FILING" && (complaint.approvedVersion == null || complaint.approvedVersion !== complaint.draftVersion)) {
    throw new IllegalTransitionError(from, to, "filing requires an approval bound to the current draft version");
  }
  return { ...complaint, status: to, statusReason: opts.reason, updatedAt: nowIso() };
}

/**
 * Validates, applies and persists a transition. Records it via
 * store.recordTransition and saves the complaint. Returns the updated draft.
 */
export async function transition(
  store: Store,
  complaint: ComplaintDraft,
  to: ComplaintState,
  opts: { reason: string; actor: Actor },
): Promise<ComplaintDraft> {
  const from = complaint.status;
  const next = applyTransition(complaint, to, opts);
  await store.recordTransition(complaint.id, from, to, opts.reason, opts.actor);
  return store.saveComplaint(next);
}

/** Material change: new version; any prior approval no longer applies. */
export function bumpDraft(complaint: ComplaintDraft): ComplaintDraft {
  return { ...complaint, draftVersion: complaint.draftVersion + 1, approvedVersion: null, approvedAt: null, updatedAt: nowIso() };
}
