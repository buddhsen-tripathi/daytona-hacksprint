import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../core/contracts.js";
import { verifyReceipt } from "./receipts.js";

const base = (over: Partial<WorkerResult> = {}): WorkerResult => ({
  attemptId: "att_1",
  status: "SUBMITTED",
  errorCode: null,
  officialRequestNumber: "31124680",
  officialReceiptUrl: "https://portal.311.nyc.gov/sr-details/?srnum=31124680",
  confirmationText: "Your service request has been submitted. Please keep this number for your records.",
  submitClicked: true,
  finalUrl: "https://portal.311.nyc.gov/sr-details/?srnum=31124680",
  steps: [],
  evidence: [{ name: "06-confirmation.png", type: "screenshot", step: "confirm", summary: "confirmation" }],
  startedAt: "2026-10-16T15:00:00.000Z",
  finishedAt: "2026-10-16T15:00:20.000Z",
  ...over,
});

describe("verifyReceipt", () => {
  it("verifies a well-formed official confirmation", () => {
    const v = verifyReceipt(base(), "real");
    expect(v).toMatchObject({ status: "SUBMITTED", officialRequestNumber: "31124680", verified: true, errorCode: null });
  });

  it("verifies real-target numeric and 311- formats", () => {
    expect(verifyReceipt(base({ officialRequestNumber: "12345678" }), "real").status).toBe("SUBMITTED");
    expect(verifyReceipt(base({ officialRequestNumber: "311-24680135" }), "real").status).toBe("SUBMITTED");
  });

  it("rejects a non-numeric number on the real street target", () => {
    expect(verifyReceipt(base({ officialRequestNumber: "SR-20261016-AB12CD" }), "real")).toMatchObject({ status: "SUBMISSION_UNKNOWN", officialRequestNumber: null, errorCode: "NO_CONFIRMATION" });
    expect(verifyReceipt(base({ officialRequestNumber: "123" }), "real").status).toBe("SUBMISSION_UNKNOWN");
  });

  it("downgrades malformed SR to SUBMISSION_UNKNOWN when submit was clicked", () => {
    const v = verifyReceipt(base({ officialRequestNumber: "SR-2026-XYZ" }), "real");
    expect(v.status).toBe("SUBMISSION_UNKNOWN");
    expect(v.officialRequestNumber).toBeNull();
    expect(v.notes).toMatch(/does not match/);
  });

  it("downgrades missing SR", () => {
    expect(verifyReceipt(base({ officialRequestNumber: null }), "real").status).toBe("SUBMISSION_UNKNOWN");
  });

  it("downgrades empty confirmation text", () => {
    const v = verifyReceipt(base({ confirmationText: "   " }), "real");
    expect(v.status).toBe("SUBMISSION_UNKNOWN");
    expect(v.notes).toMatch(/confirmationText empty/);
    expect(verifyReceipt(base({ confirmationText: null }), "real").status).toBe("SUBMISSION_UNKNOWN");
  });

  it("downgrades when there is no confirm-step evidence", () => {
    const v = verifyReceipt(base({ evidence: [{ name: "05-submit.png", type: "screenshot", step: "submit", summary: "x" }] }), "real");
    expect(v.status).toBe("SUBMISSION_UNKNOWN");
    expect(v.notes).toMatch(/no confirm-step evidence/);
  });

  it("claimed SUBMITTED without a submit click ⇒ FAILED/NO_CONFIRMATION", () => {
    const v = verifyReceipt(base({ submitClicked: false, officialRequestNumber: null }), "real");
    expect(v).toMatchObject({ status: "FAILED", errorCode: "NO_CONFIRMATION", officialRequestNumber: null, verified: false });
  });

  it("passes HUMAN_ACTION_REQUIRED through and never upgrades", () => {
    const v = verifyReceipt(base({ status: "HUMAN_ACTION_REQUIRED", errorCode: "CAPTCHA", submitClicked: false }), "real");
    expect(v).toMatchObject({ status: "HUMAN_ACTION_REQUIRED", errorCode: "CAPTCHA", officialRequestNumber: null });
  });

  it("never upgrades even when an SR-looking number is present on a non-SUBMITTED result", () => {
    const v = verifyReceipt(base({ status: "SUBMISSION_UNKNOWN", errorCode: "CONNECTION_LOST_AFTER_SUBMIT" }), "real");
    expect(v).toMatchObject({ status: "SUBMISSION_UNKNOWN", errorCode: "CONNECTION_LOST_AFTER_SUBMIT", officialRequestNumber: null });
  });

  it("SUBMISSION_UNKNOWN without code gets NO_CONFIRMATION", () => {
    expect(verifyReceipt(base({ status: "SUBMISSION_UNKNOWN", errorCode: null }), "real").errorCode).toBe("NO_CONFIRMATION");
  });

  it("keeps FAILED/FORM_REJECTED after submit as FAILED (definitive rejection)", () => {
    const v = verifyReceipt(base({ status: "FAILED", errorCode: "FORM_REJECTED", officialRequestNumber: null }), "real");
    expect(v).toMatchObject({ status: "FAILED", errorCode: "FORM_REJECTED" });
  });

  it("FAILED with a non-definitive error after submit ⇒ SUBMISSION_UNKNOWN", () => {
    const v = verifyReceipt(base({ status: "FAILED", errorCode: "BROWSER_ERROR", officialRequestNumber: null }), "real");
    expect(v).toMatchObject({ status: "SUBMISSION_UNKNOWN", errorCode: "BROWSER_ERROR" });
  });

  it("FAILED before submit stays FAILED", () => {
    const v = verifyReceipt(base({ status: "FAILED", errorCode: "NAVIGATION_FAILED", submitClicked: false, officialRequestNumber: null }), "real");
    expect(v).toMatchObject({ status: "FAILED", errorCode: "NAVIGATION_FAILED" });
  });
});
