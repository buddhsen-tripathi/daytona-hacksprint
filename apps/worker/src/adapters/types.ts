import type { Page } from "playwright-core";
import type { GuardState } from "../browser.js";
import type { EvidenceFile, FilingPayload, WorkerAnswer, WorkerEvent, WorkerQuestion, WorkerStep } from "../protocol.js";

export interface WorkerState {
  /** Set to true IMMEDIATELY BEFORE the final submit click. Never reset. */
  submitClicked: boolean;
  /** Last known URL (sanitized) for the result. */
  finalUrl: string | null;
}

export interface AdapterContext {
  page: Page;
  payload: FilingPayload;
  guard: GuardState;
  state: WorkerState;
  log(step: WorkerStep, level: WorkerEvent["level"], message: string, data?: Record<string, unknown>): void;
  shot(step: WorkerStep, name: string, summary?: string): Promise<EvidenceFile | null>;
  saveHtml(step: WorkerStep, name: string, summary?: string): Promise<EvidenceFile | null>;
  /** Throws an Outcome if the guard tripped (off-allowlist navigation). Call after every navigation. */
  checkGuard(step: WorkerStep): void;
  /**
   * Pause and ask the resident (via the bot) — the page stays open. Resolves with the answer, or throws
   * `fallback` (the adapter's original HUMAN_ACTION_REQUIRED outcome) on timeout / when questions are disabled.
   */
  ask(q: WorkerQuestion, fallback: Error): Promise<WorkerAnswer>;
}

export interface ConfirmResult {
  officialRequestNumber: string | null;
  confirmationText: string | null;
  receiptUrl: string | null;
}

export interface FormAdapter {
  readonly id: string;
  navigate(ctx: AdapterContext): Promise<void>;
  inspect(ctx: AdapterContext): Promise<{ requiredKnown: string[] }>;
  fill(ctx: AdapterContext): Promise<void>;
  validate(ctx: AdapterContext): Promise<{ ok: boolean; problems: string[] }>;
  submit(ctx: AdapterContext): Promise<void>;
  confirm(ctx: AdapterContext): Promise<ConfirmResult>;
}
