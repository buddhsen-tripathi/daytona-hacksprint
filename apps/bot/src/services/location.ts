/**
 * LocationService (design doc §6.3). Location is only ever user-provided
 * (pin or typed text) — never inferred from a photo.
 */
import { NYC_BOUNDS } from "../core/contracts.js";
import type { ComplaintLocation, LocationService } from "../core/contracts.js";
import { geosearchForward, geosearchReverse, intersectionLookup, splitIntersection } from "../integrations/geosearch.js";
import type { GeoFeature } from "../integrations/geosearch.js";

export function withinNyc(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= NYC_BOUNDS.minLat && lat <= NYC_BOUNDS.maxLat && lon >= NYC_BOUNDS.minLon && lon <= NYC_BOUNDS.maxLon;
}

const STREET_WORDS =
  "st|str|street|ave|av|avenue|blvd|boulevard|rd|road|pl|place|pkwy|parkway|dr|drive|ln|lane|ct|court|ter|terrace|way|broadway|bowery|hwy|highway|expy|expressway|plaza|sq|square|loop|row|alley|crescent|walk|path|concourse|turnpike|tpke";
const STREET_WORD_RE = new RegExp(`\\b(${STREET_WORDS})\\b\\.?`, "i");
const BOROUGH_RE = /\b(manhattan|brooklyn|queens|bronx|staten island|nyc|new york,? ny|new york city|astoria|harlem|williamsburg|bushwick|flushing|jamaica|midtown|soho|tribeca|chelsea)\b/i;
const ZIP_RE = /\b1[01]\d{3}\b/; // NYC zips are 100xx-116xx
const HOUSE_NUMBER_STREET_RE = new RegExp(`\\b\\d{1,6}(-\\d{1,4})?[a-z]?\\s+([nsew]\\.?\\s+|north\\s+|south\\s+|east\\s+|west\\s+)?[\\w'.]+(\\s+[\\w'.]+){0,3}\\s+(${STREET_WORDS})\\b`, "i");
const NUMBERED_STREET_RE = /\b\d{1,3}(st|nd|rd|th)\s+(st|street|ave|avenue|av|rd|road|pl|place|dr|drive)\b/i;
const CORNER_RE = /\b(corner of|intersection of|cross street|between)\b/i;

/** Street-ish token: has a street suffix, a numbered street, or a well-known single-word NYC street. */
function streetish(s: string): boolean {
  const t = s.trim();
  if (!t || t.split(/\s+/).length > 6) return false;
  return STREET_WORD_RE.test(t) || /\b\d{1,3}(st|nd|rd|th)\b/i.test(t) || /^(broadway|bowery)$/i.test(t);
}

/**
 * Cheap, network-free check: does this text plausibly contain a location?
 * Ordinary sentences ("the road is completely broken") must return false so
 * the orchestrator treats them as descriptions.
 */
export function looksLikeAddress(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 4 || t.length > 200) return false;
  if (HOUSE_NUMBER_STREET_RE.test(t)) return true;
  if (CORNER_RE.test(t) && STREET_WORD_RE.test(t)) return true;
  if (ZIP_RE.test(t) && (STREET_WORD_RE.test(t) || t.length < 40)) return true;
  const inter = splitIntersection(t);
  if (inter && streetish(inter[0]) && streetish(inter[1])) return true;
  if (BOROUGH_RE.test(t) && (STREET_WORD_RE.test(t) || NUMBERED_STREET_RE.test(t))) return true;
  // Short message that is basically just a street name ("W 45th St", "Flatbush Ave, Brooklyn")
  const words = t.split(/\s+/);
  if (words.length <= 5 && NUMBERED_STREET_RE.test(t)) return true;
  if (words.length <= 4 && STREET_WORD_RE.test(words[words.length - 1] ?? "") && /^[A-Z0-9]/.test(t) && !/[.!?]$/.test(t)) return true;
  return false;
}

function titleBorough(b: string | null): string | null {
  if (!b) return null;
  return b.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function fromFeature(f: GeoFeature, rawInput: string): ComplaintLocation {
  return {
    latitude: f.latitude,
    longitude: f.longitude,
    address: f.label || null,
    borough: titleBorough(f.borough),
    rawInput,
    source: "text",
    userConfirmed: true,
    withinNyc: withinNyc(f.latitude, f.longitude),
  };
}

/** Accept a GeoSearch hit only if it's in NYC and plausibly what the user meant. */
function acceptable(f: GeoFeature, text: string): boolean {
  if (!withinNyc(f.latitude, f.longitude)) return false;
  if (f.confidence != null && f.confidence < 0.6) return false;
  // Street-level / area centroids are too imprecise for a pothole report.
  if (f.layer && !["address", "venue", "intersection"].includes(f.layer)) return false;
  const num = text.match(/(?:^|\s)(\d{1,6}(?:-\d{1,4})?)[a-z]?\s+\S/i)?.[1] ?? null;
  // A house number the user never typed means GeoSearch guessed one.
  if (!num && f.housenumber) return false;
  if (num && f.housenumber && !f.housenumber.toLowerCase().startsWith(num.toLowerCase())) return false;
  return true;
}

function boroughHint(text: string): string | null {
  const m = text.match(/\b(manhattan|brooklyn|queens|bronx|staten island)\b/i);
  return m ? titleBorough(m[1]) : null;
}

export type LocationServiceOptions = { timeoutMs?: number };

export function createLocationService(opts: LocationServiceOptions = {}): LocationService {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  return {
    withinNyc,

    async fromPin(lat, lon) {
      const base: ComplaintLocation = {
        latitude: lat,
        longitude: lon,
        address: null,
        borough: null,
        rawInput: null,
        source: "pin",
        userConfirmed: true,
        withinNyc: withinNyc(lat, lon),
      };
      if (!base.withinNyc) return base;
      try {
        const f = await geosearchReverse(lat, lon, { timeoutMs });
        if (f) return { ...base, address: f.label || null, borough: titleBorough(f.borough) };
      } catch {
        /* best effort */
      }
      return base;
    },

    async fromText(text) {
      const raw = (text ?? "").trim();
      if (!looksLikeAddress(raw)) return null;
      const hint = boroughHint(raw);
      const query = /\b(nyc|new york|manhattan|brooklyn|queens|bronx|staten island)\b/i.test(raw) ? raw : `${raw}, New York, NY`;

      const inter = splitIntersection(raw);
      if (inter && !/^\s*\d/.test(raw)) {
        try {
          const f = await intersectionLookup(inter[0], inter[1], { timeoutMs: Math.max(timeoutMs, 6_000) });
          if (f && withinNyc(f.latitude, f.longitude) && (!hint || !f.borough || f.borough === hint)) return fromFeature(f, raw);
        } catch {
          /* fall through to GeoSearch */
        }
      }

      try {
        const feats = await geosearchForward(query, { size: 5, timeoutMs });
        const candidates = feats.filter((f) => acceptable(f, raw));
        const preferred = (hint ? candidates.find((f) => titleBorough(f.borough) === hint) : null) ?? candidates[0];
        if (preferred) return fromFeature(preferred, raw);
        // A confident hit outside NYC: report it so the bot can explain jurisdiction.
        const outside = feats.find((f) => !withinNyc(f.latitude, f.longitude) && (f.confidence ?? 0) >= 0.8);
        if (outside) return fromFeature(outside, raw);
      } catch {
        /* geocoder down */
      }
      return null;
    },
  };
}
