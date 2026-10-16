import { describe, expect, it } from "vitest";
import { resolveAdapter } from "../src/adapters/registry.js";
import { validatePayload } from "../src/protocol.js";
import { testPayload } from "./helpers.js";

describe("adapter registry", () => {
  it("subway-delay defaults to the hand-written MTA adapter", () => {
    const r = resolveAdapter(testPayload());
    expect(r.ok && r.adapterId).toBe("mta-subway-delay");
    expect(r.ok && r.create().id).toBe("mta-subway-delay");
  });

  it("explicit adapter:<id> must be bound to the category", () => {
    expect(resolveAdapter(testPayload({ automation: "adapter:mta-subway-delay" })).ok).toBe(true);
    const r = resolveAdapter(testPayload({ category: "abandoned-vehicle", automation: "adapter:mta-subway-delay" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not registered for category "abandoned-vehicle"/);
  });

  it("unknown category / unknown adapter / none ⇒ no adapter", () => {
    expect(resolveAdapter(testPayload({ category: "no-such-thing" })).ok).toBe(false);
    expect(resolveAdapter(testPayload({ automation: "adapter:nope" })).ok).toBe(false);
    const none = resolveAdapter(testPayload({ category: "noise-from-neighbor", automation: "none" }));
    expect(!none.ok && none.reason).toMatch(/phone or information only/);
  });

  it("validatePayload accepts any catalog slug but rejects junk categories/automation", () => {
    expect(validatePayload(testPayload({ category: "abandoned-vehicle" }))).toEqual([]);
    expect(validatePayload(testPayload({ category: "Bad Category" }))).toContain("category must be a catalog slug [a-z0-9-]+");
    expect(validatePayload({ ...testPayload(), automation: "rm -rf" })).toContain("automation must be none|handoff|adapter:<id>");
  });
});
