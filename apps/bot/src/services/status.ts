/**
 * StatusService (design doc §15): /status <SR>.
 *  - DEMO-YYYYMMDD-XXXXXX ⇒ controlled demo portal GET /api/status/<sr>
 *  - anything else        ⇒ NYC Open Data (erm2-nwe9, refreshed daily)
 * Never throws; unknown is a valid answer.
 */
import type { DuplicateService } from "../core/contracts.js";
import { createDuplicateService } from "./duplicates.js";

export const DEMO_SR_RE = /^DEMO-\d{8}-[A-Z0-9]{6}$/i;

export type StatusLookup = {
  sr: string;
  status: string | null;
  source: "open-data" | "demo-portal" | "unknown";
  detail: string;
};

export type StatusService = {
  lookup(sr: string, opts: { target: "demo" | "real"; demoPortalUrl?: string; demoPortalHeaders?: Record<string, string> }): Promise<StatusLookup>;
};

function fmtDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : s;
}

export function createStatusService(deps: { duplicates?: DuplicateService; timeoutMs?: number } = {}): StatusService {
  const duplicates = deps.duplicates ?? createDuplicateService();
  const timeoutMs = deps.timeoutMs ?? 8_000;
  return {
    async lookup(rawSr, opts) {
      const sr = rawSr.trim().replace(/^#/, "").toUpperCase();
      if (!sr) return { sr, status: null, source: "unknown", detail: "No service request number given." };

      if (DEMO_SR_RE.test(sr)) {
        const base = (opts.demoPortalUrl ?? process.env.DEMO_PORTAL_URL ?? "").replace(/\/+$/, "");
        if (!base) return { sr, status: null, source: "unknown", detail: "This is a demo-portal request number, but the demo portal isn't running right now." };
        try {
          const res = await fetch(`${base}/api/status/${encodeURIComponent(sr)}`, {
            headers: { Accept: "application/json", ...(opts.demoPortalHeaders ?? {}) },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.status === 404) return { sr, status: null, source: "unknown", detail: "The demo portal has no record of this request number." };
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = (await res.json()) as { status?: string; category?: string; createdAt?: string };
          const parts = [`Status: ${j.status ?? "unknown"}`];
          if (j.category) parts.push(`Category: ${j.category}`);
          const created = fmtDate(j.createdAt);
          if (created) parts.push(`Submitted: ${created}`);
          parts.push("Source: NYC311 Demo Portal (not the official site)");
          return { sr, status: j.status ?? null, source: "demo-portal", detail: parts.join("\n") };
        } catch (err) {
          return { sr, status: null, source: "unknown", detail: `Couldn't reach the demo portal (${(err as Error).message}).` };
        }
      }

      const digits = sr.replace(/\D/g, "");
      if (!/^\d{5,12}$/.test(digits)) return { sr, status: null, source: "unknown", detail: "That doesn't look like a NYC311 service request number." };
      const rec = await duplicates.lookupStatus(digits);
      if (!rec) {
        return {
          sr: digits,
          status: null,
          source: "unknown",
          detail:
            "I couldn't find this request in NYC Open Data yet. The public data is updated daily, so new requests can take a day or two to appear. You can also check https://portal.311.nyc.gov/check-status/",
        };
      }
      const parts = [`Status: ${rec.status ?? "unknown"}`, `Type: ${rec.complaintType}${rec.descriptor ? ` — ${rec.descriptor}` : ""}`];
      const created = fmtDate(rec.createdDate);
      if (created) parts.push(`Opened: ${created}`);
      const closed = fmtDate(rec.closedDate);
      if (closed) parts.push(`Closed: ${closed}`);
      if (rec.incidentAddress) parts.push(`Address: ${rec.incidentAddress}`);
      if (rec.resolutionDescription) parts.push(`Resolution: ${rec.resolutionDescription}`);
      parts.push("Source: NYC Open Data (updated daily)");
      return { sr: digits, status: rec.status, source: "open-data", detail: parts.join("\n") };
    },
  };
}
