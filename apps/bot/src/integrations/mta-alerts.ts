/**
 * Live MTA subway service alerts (GTFS-RT JSON, public, no key): the subway
 * analogue of the Open Data duplicate check. Used only to corroborate a
 * resident's subway-delay report on the draft card; it never changes what the
 * resident said and never blocks filing. Never throws: failure ⇒ empty list.
 */
export const MTA_SUBWAY_ALERTS_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json";

export type MtaAlert = {
  id: string;
  /** mercury alert_type, e.g. "Delays", "Planned - Part Suspended". */
  type: string;
  header: string;
  description: string | null;
  active: boolean;
  routes: string[];
};

export type MtaAlertsResult = { alerts: MtaAlert[]; fetchedAt: string | null; source: "mta" | "unavailable" };

type Translation = { language?: string; text?: string };
type FeedEntity = {
  id?: string;
  alert?: {
    active_period?: { start?: number; end?: number }[];
    informed_entity?: { route_id?: string }[];
    header_text?: { translation?: Translation[] };
    description_text?: { translation?: Translation[] };
    "transit_realtime.mercury_alert"?: { alert_type?: string };
  };
};

/** contracts.SUBWAY_LINES value → GTFS route_id(s). */
export function routeIdsForLine(line: string): string[] {
  const l = line.trim();
  if (/42/.test(l) && /shuttle/i.test(l)) return ["GS"];
  if (/franklin/i.test(l)) return ["FS"];
  if (/rockaway/i.test(l)) return ["H"];
  if (/staten/i.test(l) || /^SIR?$/i.test(l)) return ["SI"];
  const u = l.toUpperCase();
  if (u === "6") return ["6", "6X"];
  if (u === "7") return ["7", "7X"];
  return [u];
}

function english(t: { translation?: Translation[] } | undefined): string | null {
  const list = t?.translation ?? [];
  const hit = list.find((x) => x.language === "en") ?? list.find((x) => !x.language) ?? list.find((x) => x.language !== "en-html");
  const text = hit?.text?.trim();
  return text ? text : null;
}

function isActive(periods: { start?: number; end?: number }[] | undefined, nowSec: number): boolean {
  if (!periods || periods.length === 0) return true;
  return periods.some((p) => (p.start == null || Number(p.start) <= nowSec) && (p.end == null || Number(p.end) === 0 || Number(p.end) > nowSec));
}

/** Unplanned delay alerts are what corroborates a delay report (planned work is not). */
export function isDelayAlert(a: MtaAlert): boolean {
  return a.active && /delay/i.test(a.type) && !/^planned/i.test(a.type);
}

export function parseAlerts(feed: unknown, nowSec = Math.floor(Date.now() / 1000)): MtaAlert[] {
  const entities = ((feed as { entity?: FeedEntity[] } | null)?.entity ?? []) as FeedEntity[];
  const out: MtaAlert[] = [];
  for (const e of entities) {
    const a = e.alert;
    if (!a) continue;
    const header = english(a.header_text);
    if (!header) continue;
    out.push({
      id: String(e.id ?? ""),
      type: a["transit_realtime.mercury_alert"]?.alert_type ?? "Alert",
      header,
      description: english(a.description_text),
      active: isActive(a.active_period, nowSec),
      routes: [...new Set((a.informed_entity ?? []).map((i) => i.route_id).filter((r): r is string => !!r))],
    });
  }
  return out;
}

let cache: { at: number; alerts: MtaAlert[]; fetchedAt: string } | null = null;
const CACHE_MS = 60_000;

export async function fetchAllAlerts(opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<MtaAlertsResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { alerts: cache.alerts, fetchedAt: cache.fetchedAt, source: "mta" };
  try {
    const res = await (opts.fetchImpl ?? fetch)(MTA_SUBWAY_ALERTS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const alerts = parseAlerts(await res.json());
    const fetchedAt = new Date().toISOString();
    cache = { at: Date.now(), alerts, fetchedAt };
    return { alerts, fetchedAt, source: "mta" };
  } catch (err) {
    console.warn("[mta-alerts] feed unavailable:", (err as Error).message);
    return { alerts: [], fetchedAt: null, source: "unavailable" };
  }
}

/** Active alerts that mention the line (delay alerts first). */
export async function getActiveAlertsForLine(line: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<MtaAlertsResult> {
  const all = await fetchAllAlerts(opts);
  const ids = new Set(routeIdsForLine(line));
  const alerts = all.alerts.filter((a) => a.active && a.routes.some((r) => ids.has(r))).sort((a, b) => Number(isDelayAlert(b)) - Number(isDelayAlert(a)));
  return { alerts, fetchedAt: all.fetchedAt, source: all.source };
}

/** Tests only. */
export function _resetMtaAlertsCache() {
  cache = null;
}
