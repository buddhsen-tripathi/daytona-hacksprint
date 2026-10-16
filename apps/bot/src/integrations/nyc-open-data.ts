/**
 * NYC Open Data — 311 Service Requests from 2020 to Present (erm2-nwe9), via
 * Socrata SODA. Data is refreshed daily, not real time (design doc §12.1).
 */
export const ERM2_NWE9_URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const DEFAULT_TIMEOUT_MS = 8_000;

/** Raw row shape (Socrata returns every value as a string; absent fields are omitted). */
export type Raw311Record = {
  unique_key: string;
  created_date: string;
  closed_date?: string;
  complaint_type: string;
  descriptor?: string;
  status?: string;
  incident_address?: string;
  latitude?: string;
  longitude?: string;
  resolution_description?: string;
  resolution_action_updated_date?: string;
  borough?: string;
};

export const SELECT_FIELDS = "unique_key,created_date,closed_date,complaint_type,descriptor,status,incident_address,latitude,longitude,resolution_description,resolution_action_updated_date,borough";

function soqlString(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Socrata floating timestamps have no zone; NYC Open Data stores them in local (America/New_York) time. */
export function socrataTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19);
}

async function query(params: Record<string, string>, timeoutMs: number): Promise<Raw311Record[]> {
  const url = `${ERM2_NWE9_URL}?${new URLSearchParams(params)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = process.env.NYC_OPEN_DATA_APP_TOKEN;
  if (token) headers["X-App-Token"] = token;
  const deadline = Date.now() + timeoutMs;
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  // Socrata throttles anonymous clients with 429/503; one short retry inside the same budget.
  if ((res.status === 429 || res.status === 503) && deadline - Date.now() > 2_000) {
    await new Promise((r) => setTimeout(r, 1_000));
    res = await fetch(url, { headers, signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) });
  }
  if (!res.ok) throw new Error(`Open Data HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("Open Data returned a non-array body");
  return json as Raw311Record[];
}

export async function searchNearby(args: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  complaintType: string;
  since: Date;
  limit?: number;
  timeoutMs?: number;
}): Promise<Raw311Record[]> {
  const where = [
    `within_circle(location, ${args.latitude}, ${args.longitude}, ${Math.round(args.radiusMeters)})`,
    `complaint_type=${soqlString(args.complaintType)}`,
    `created_date > ${soqlString(socrataTimestamp(args.since))}`,
  ].join(" AND ");
  return query({ $where: where, $select: SELECT_FIELDS, $order: "created_date DESC", $limit: String(args.limit ?? 50) }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function getByUniqueKey(uniqueKey: string, opts: { timeoutMs?: number } = {}): Promise<Raw311Record | null> {
  const key = uniqueKey.trim();
  if (!/^\d{5,12}$/.test(key)) return null;
  const rows = await query({ $where: `unique_key=${soqlString(key)}`, $select: SELECT_FIELDS, $limit: "1" }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return rows[0] ?? null;
}
