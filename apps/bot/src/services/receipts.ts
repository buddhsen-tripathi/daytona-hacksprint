/**
 * Receipt verification (design doc §9.4, ARCHITECTURE "Receipt verification").
 *
 * The worker's claim is never trusted on its own. A filing is SUBMITTED only when:
 *   1. the worker reported SUBMITTED,
 *   2. officialRequestNumber matches the target's SR pattern,
 *   3. confirmationText (raw text of the confirmation region) is non-empty,
 *   4. at least one evidence file was captured at the `confirm` step.
 * Otherwise the result is downgraded: submit clicked ⇒ SUBMISSION_UNKNOWN (never
 * retried automatically), else FAILED/NO_CONFIRMATION. This function never
 * upgrades anything to SUBMITTED.
 */
import type { CategoryId, FilingErrorCode, FilingStatus, FilingTarget, WorkerResult } from "../core/contracts.js";

/**
 * SR number patterns per target.
 * - real: NYC311-style service request numbers are numeric (e.g. "311-12345678" on the portal, bare digits in
 *   Open Data `unique_key`). We accept 6–12 digits or `311-<digits>` and rely on confirmationText + evidence for
 *   the rest. MTA references are handled separately (isRealOnly categories).
 */
export const SR_PATTERNS: Record<FilingTarget, RegExp> = {
  real: /^\d{6,12}$|^311-\d+$/,
};

/**
 * Category-specific reference patterns that override the target pattern.
 * subway-delay: MTA Customer Feedback (Salesforce) case/reference numbers; exact format not yet
 * observed on a real submission, so accept any `[A-Z0-9-]{5,}` and rely on confirmation text + evidence.
 */
export const CATEGORY_SR_PATTERNS: Partial<Record<CategoryId, RegExp>> = {
  "subway-delay": /^[A-Z0-9-]{5,}$/i,
};

export function srPatternFor(target: FilingTarget, category?: CategoryId | null): RegExp {
  return (category && CATEGORY_SR_PATTERNS[category]) || SR_PATTERNS[target];
}

export type ReceiptVerification = {
  status: FilingStatus;
  /** Only set when status === SUBMITTED (verified). */
  officialRequestNumber: string | null;
  /** errorCode to persist alongside the status (null when verified SUBMITTED). */
  errorCode: FilingErrorCode | null;
  verified: boolean;
  notes: string;
};

/** Error codes after which a clicked submit is a definitive "nothing was filed". */
const DEFINITIVE_REJECTIONS: ReadonlySet<FilingErrorCode> = new Set<FilingErrorCode>(["FORM_REJECTED"]);

export function verifyReceipt(result: WorkerResult, target: FilingTarget, category?: CategoryId | null): ReceiptVerification {
  const pattern = srPatternFor(target, category);
  if (result.status !== "SUBMITTED") {
    // Never upgrade. One safety downgrade: a FAILED after the submit click that is not a
    // definitive form rejection might still have created a record ⇒ treat as unknown.
    if (result.status === "FAILED" && result.submitClicked && !(result.errorCode && DEFINITIVE_REJECTIONS.has(result.errorCode))) {
      return {
        status: "SUBMISSION_UNKNOWN",
        officialRequestNumber: null,
        errorCode: result.errorCode ?? "NO_CONFIRMATION",
        verified: false,
        notes: `worker reported FAILED (${result.errorCode ?? "no code"}) after submit was clicked; outcome cannot be ruled out ⇒ SUBMISSION_UNKNOWN`,
      };
    }
    return {
      status: result.status,
      officialRequestNumber: null,
      errorCode: result.errorCode ?? (result.status === "SUBMISSION_UNKNOWN" ? "NO_CONFIRMATION" : null),
      verified: false,
      notes: `worker reported ${result.status}${result.errorCode ? `/${result.errorCode}` : ""}; passed through unchanged`,
    };
  }

  const problems: string[] = [];
  const sr = result.officialRequestNumber?.trim() ?? "";
  if (!sr) problems.push("no officialRequestNumber");
  else if (!pattern.test(sr)) problems.push(`officialRequestNumber "${sr}" does not match ${category ?? target} pattern ${pattern}`);
  if (!result.confirmationText || !result.confirmationText.trim()) problems.push("confirmationText empty");
  if (!result.evidence.some((e) => e.step === "confirm")) problems.push("no confirm-step evidence");

  if (problems.length === 0) {
    return {
      status: "SUBMITTED",
      officialRequestNumber: sr,
      errorCode: null,
      verified: true,
      notes: `verified: SR ${sr} matches ${category && CATEGORY_SR_PATTERNS[category] ? category : target} pattern, confirmation text present, ${result.evidence.filter((e) => e.step === "confirm").length} confirm evidence file(s)`,
    };
  }

  if (result.submitClicked) {
    return {
      status: "SUBMISSION_UNKNOWN",
      officialRequestNumber: null,
      errorCode: "NO_CONFIRMATION",
      verified: false,
      notes: `worker claimed SUBMITTED but verification failed (${problems.join("; ")}); submit was clicked ⇒ SUBMISSION_UNKNOWN`,
    };
  }
  return {
    status: "FAILED",
    officialRequestNumber: null,
    errorCode: "NO_CONFIRMATION",
    verified: false,
    notes: `worker claimed SUBMITTED but verification failed (${problems.join("; ")}); submit was never clicked ⇒ FAILED`,
  };
}
