import type { Page } from "playwright-core";
import { Outcome, type FilingPayload } from "../protocol.js";
import type { AdapterContext } from "./types.js";

export const BOROUGHS = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"] as const;
export type Borough = (typeof BOROUGHS)[number];

/** "Ada Lovelace" → {first:"Ada", last:"Lovelace"}; "Ada King Lovelace" → last "King Lovelace". Single word / null ⇒ null. */
export function splitName(contactName: string | null): { first: string; last: string } | null {
  const parts = (contactName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/** ISO YYYY-MM-DD (or full ISO timestamp) → MM/DD/YYYY. Invalid ⇒ null (leave blank, never invent). */
export function isoToUsDate(iso: string | null): string | null {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

export function normalizeBorough(b: string | null | undefined): Borough | null {
  const s = (b ?? "").trim().toLowerCase().replace(/^the\s+/, "");
  if (!s) return null;
  if (s === "manhattan" || s === "new york" || s === "new york county") return "Manhattan";
  if (s === "bronx") return "Bronx";
  if (s === "brooklyn" || s === "kings") return "Brooklyn";
  if (s === "queens") return "Queens";
  if (s === "staten island" || s === "richmond") return "Staten Island";
  return null;
}

export interface ParsedLocation {
  borough: Borough | null;
  houseNumber: string | null;
  onStreet: string | null;
  crossStreet1: string | null;
  crossStreet2: string | null;
  locationType: "Street" | "Intersection";
}

/**
 * Best-effort parse of a normalized address.
 *  "1515 Broadway, Manhattan"                  → house 1515, on "Broadway"
 *  "Broadway & W 45th St, Manhattan"           → on "Broadway", cross1 "W 45th St", Intersection
 *  "Atlantic Ave between Nevins St and 3rd Ave" → on "Atlantic Ave", cross1 "Nevins St", cross2 "3rd Ave"
 * Borough: payload.form.borough first, else any comma part naming a borough.
 */
export function parseAddress(address: string | null, borough: string | null): ParsedLocation {
  const out: ParsedLocation = { borough: normalizeBorough(borough), houseNumber: null, onStreet: null, crossStreet1: null, crossStreet2: null, locationType: "Street" };
  const parts = (address ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!out.borough) for (const p of parts.slice(1)) if ((out.borough = normalizeBorough(p))) break;
  const first = parts[0];
  if (!first) return out;
  const between = first.match(/^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/i);
  if (between) {
    out.onStreet = between[1]!.trim();
    out.crossStreet1 = between[2]!.trim();
    out.crossStreet2 = between[3]!.trim();
    return out;
  }
  const inter = first.split(/\s+(?:&|and|at)\s+|\s*\/\s*/i);
  if (inter.length >= 2 && inter[0] && inter[1]) {
    out.onStreet = inter[0].trim();
    out.crossStreet1 = inter[1].trim();
    out.locationType = "Intersection";
    return out;
  }
  const hn = first.match(/^(\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/);
  if (hn) {
    out.houseNumber = hn[1]!;
    out.onStreet = hn[2]!.trim();
  } else out.onStreet = first;
  return out;
}

export function needField(message: string, data?: Record<string, unknown>): never {
  throw needFieldOutcome(message, data);
}

/** The HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD outcome without throwing (ctx.ask fallback). */
export function needFieldOutcome(message: string, data?: Record<string, unknown>): Outcome {
  return new Outcome("HUMAN_ACTION_REQUIRED", "UNEXPECTED_REQUIRED_FIELD", message, data);
}

/** goto with bounded retries (navigation only — never used after submit). */
export async function gotoWithRetries(ctx: AdapterContext, url: string, waitForSelector: string) {
  const { page, payload } = ctx;
  const attempts = Math.max(1, Math.min(5, (payload.limits.maxNavigationRetries ?? 0) + 1));
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: payload.limits.stepTimeoutMs });
      ctx.checkGuard("navigate");
      if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
      await page.waitForSelector(waitForSelector, { state: "visible", timeout: payload.limits.stepTimeoutMs });
      return;
    } catch (err) {
      if (err instanceof Outcome) throw err;
      ctx.checkGuard("navigate");
      lastErr = err;
      ctx.log("navigate", "warn", `navigation attempt ${i}/${attempts} failed: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
    }
  }
  throw new Outcome("FAILED", "NAVIGATION_FAILED", `Could not open the reporting form after ${attempts} attempt(s): ${String((lastErr as Error)?.message ?? lastErr).split("\n")[0]}`);
}

export async function textOf(page: Page, selector: string): Promise<string | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  const t = (await loc.innerText({ timeout: 2000 }).catch(() => "")).trim();
  return t || null;
}

/** Field checks: does this text input accept free text of this length? */
export async function acceptsFreeText(page: Page, selector: string, text: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, t) => {
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
      if (el instanceof HTMLInputElement && !["text", "search", ""].includes(el.type)) return false;
      if (el.readOnly || el.disabled) return false;
      if (el.getAttribute("pattern")) {
        try {
          if (!new RegExp(`^(?:${el.getAttribute("pattern")})$`).test(t)) return false;
        } catch {
          return false;
        }
      }
      if (el.maxLength > 0 && el.maxLength < t.length) return false;
      if (el.getAttribute("list")) return false; // autocomplete-backed fields expect known values
      return true;
    }, text)
    .catch(() => false);
}

export function payloadSummary(p: FilingPayload) {
  return {
    target: p.target,
    category: p.category,
    hasContactName: !!p.form.contactName,
    hasEmail: !!p.form.contactEmail,
    hasPhone: !!p.form.contactPhone,
    hasAddress: !!p.form.address,
    borough: p.form.borough,
  };
}

// ---------------------------------------------------------------------------
// Option matching shared by the hand-written MTA adapter and the recipe interpreter (identical behaviour).
// ---------------------------------------------------------------------------
const STOP = new Set(["the", "to", "toward", "towards", "train", "trains", "line", "bound", "going", "heading", "headed", "direction", "in", "on", "at", "st", "av", "ave", "avs", "street", "avenue", "and", "of", "from", "into", "a", "an", "way", "side", "service", "-", "&"]);
const SYN: Record<string, string> = { northbound: "uptown", north: "uptown", up: "uptown", southbound: "downtown", south: "downtown", down: "downtown", center: "ctr", centre: "ctr", square: "sq", wtc: "ctr", bx: "bronx", bk: "brooklyn", bklyn: "brooklyn", city: "manhattan" };

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/-bound\b/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => SYN[t] ?? t);
}

/**
 * Pick the option whose (core) label best overlaps what the resident said, token-wise (synonyms: northbound→uptown, …).
 * Unique best overlap wins; zero overlap or a tie ⇒ null (ask, never guess).
 */
export function matchByTokens(said: string | null | undefined, options: string[], core: (label: string) => string = (l) => l): string | null {
  const want = new Set(tokens(said ?? ""));
  if (!want.size || !options.length) return null;
  const scored = options.map((o) => {
    const have = new Set(tokens(core(o)));
    let score = 0;
    for (const t of want) if (have.has(t)) score++;
    return { o, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]!.score === 0) return null;
  if (scored.length > 1 && scored[1]!.score === scored[0]!.score) return null;
  return scored[0]!.o;
}

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "av")
    .replace(/\bave\b/g, "av")
    .replace(/\bavenues\b|\bavs\b/g, "avs")
    .replace(/\bsquare\b/g, "sq")
    .replace(/\bcenter\b/g, "ctr")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bwest\b/g, "w")
    .replace(/\beast\b/g, "e")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\bstation\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Options for what the resident said: exact (normalized: street→st, 14th→14, …) matches, else whole-word contains matches. */
export function nameCandidates(said: string | null | undefined, options: string[]): string[] {
  const w = normName(said ?? "");
  if (!w) return [];
  const exact = options.filter((o) => normName(o) === w);
  if (exact.length) return exact;
  const re = new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  return options.filter((o) => re.test(normName(o)));
}
