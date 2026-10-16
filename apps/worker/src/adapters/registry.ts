/**
 * Adapter registry (#9): which FormAdapter files a payload. Pure (no browser), so main.ts resolves it BEFORE opening
 * anything: no adapter ⇒ FAILED/NO_ADAPTER and nothing is opened or submitted.
 *
 * Resolution order:
 *   1. payload.automation, when present (CatalogEntry.automation, sent by the bot):
 *        "none"            ⇒ no adapter (phone / info only)
 *        "handoff"         ⇒ adapters/handoff.ts for any category (opens formUrl, prefills, NEVER submits)
 *        "adapter:<id>"    ⇒ ADAPTERS[id], only if that adapter is bound to payload.category (ADAPTER_CATEGORIES)
 *   2. otherwise the category's default (CATEGORY_DEFAULTS), e.g. subway-delay → adapter:mta-subway-delay
 *   3. otherwise ⇒ no adapter.
 * Adding a hand-written adapter = one ADAPTERS entry + its categories in ADAPTER_CATEGORIES (+ CATEGORY_DEFAULTS).
 */
import type { FilingPayload } from "../protocol.js";
import { createHandoffAdapter } from "./handoff.js";
import { createMtaSubwayDelayAdapter } from "./mta-subway-delay.js";
import type { FormAdapter } from "./types.js";

export type AdapterFactory = (p: FilingPayload) => FormAdapter;

/** Hand-written adapters by id (the `<id>` in `adapter:<id>`). */
export const ADAPTERS: Record<string, AdapterFactory> = {
  "mta-subway-delay": () => createMtaSubwayDelayAdapter(),
};

/** A hand-written adapter only ever runs for the categories it was written for (a payload cannot point it elsewhere). */
export const ADAPTER_CATEGORIES: Record<string, readonly string[]> = {
  "mta-subway-delay": ["subway-delay"],
};

/** Default automation per category when the payload carries none. */
export const CATEGORY_DEFAULTS: Record<string, string> = {
  "subway-delay": "adapter:mta-subway-delay",
};

export type Resolution = { ok: true; adapterId: string; automation: string; create: () => FormAdapter } | { ok: false; automation: string | null; reason: string };

export function resolveAdapter(p: FilingPayload): Resolution {
  const automation = p.automation ?? CATEGORY_DEFAULTS[p.category] ?? null;
  if (!automation) return { ok: false, automation: null, reason: `No filing adapter for category "${p.category}".` };
  if (automation === "none") return { ok: false, automation, reason: `Category "${p.category}" has no online filing route (phone or information only).` };
  if (automation === "handoff") return { ok: true, adapterId: "handoff", automation, create: () => createHandoffAdapter() };
  const m = automation.match(/^adapter:([a-z0-9-]+)$/);
  if (m) {
    const id = m[1]!;
    const factory = ADAPTERS[id];
    if (!factory) return { ok: false, automation, reason: `Unknown adapter "${id}" for category "${p.category}".` };
    if (!(ADAPTER_CATEGORIES[id] ?? []).includes(p.category)) return { ok: false, automation, reason: `Adapter "${id}" is not registered for category "${p.category}".` };
    return { ok: true, adapterId: id, automation, create: () => factory(p) };
  }
  return { ok: false, automation, reason: `Unsupported automation "${automation}" for category "${p.category}".` };
}
