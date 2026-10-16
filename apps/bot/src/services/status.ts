/**
 * StatusService (design doc §15): /status <SR>.
 *  - NYC311 SR numbers ⇒ NYC Open Data (erm2-nwe9, refreshed daily)
 *  - MTA references are answered by the orchestrator from the stored OfficialRequest (no public status feed)
 * Never throws; unknown is a valid answer.
 */
import type { DuplicateService } from "../core/contracts.js";
import { createDuplicateService } from "./duplicates.js";

export type StatusLookup = {
  sr: string;
  status: string | null;
  source: "open-data" | "unknown";
  detail: string;
};

export type StatusService = {
  lookup(sr: string, opts?: { target?: "real" }): Promise<StatusLookup>;
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
    async lookup(rawSr) {
      const sr = rawSr.trim().replace(/^#/, "").toUpperCase();
      if (!sr) return { sr, status: null, source: "unknown", detail: "No service request number given." };

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
