import type { FilingPayload } from "../src/protocol.js";

/** A valid payload for tests (dry run, local browser). Override anything. */
export function testPayload(over: Partial<Omit<FilingPayload, "form">> & { form?: Partial<FilingPayload["form"]> } = {}): FilingPayload {
  const { form, ...rest } = over;
  return {
    attemptId: "att_test",
    complaintId: "cmp_test",
    approvedVersion: 1,
    target: "real",
    category: "subway-delay",
    formUrl: "https://contact.mta.info/s/customer-feedback",
    allowedHosts: ["contact.mta.info", "mta.info", "new.mta.info"],
    extraHeaders: {},
    cdpUrl: null,
    liveViewUrl: null,
    realSubmitAuthorized: false,
    limits: { totalTimeoutMs: 120_000, stepTimeoutMs: 15_000, maxNavigationRetries: 0, questionTimeoutMs: 0 },
    ...rest,
    form: {
      description: "A train held for 20 minutes.",
      address: null,
      borough: null,
      latitude: null,
      longitude: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      dateObserved: null,
      transit: null,
      ...(form ?? {}),
    },
  };
}
