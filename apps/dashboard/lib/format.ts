import type { ComplaintState, Health } from "./types";

export const STATE_ORDER: ComplaintState[] = [
  "RECEIVED",
  "TRIAGING",
  "NEEDS_INFORMATION",
  "DUPLICATE_REVIEW",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "FILING",
  "SUBMITTED",
  "TRACKING",
  "HUMAN_ACTION_REQUIRED",
  "SUBMISSION_UNKNOWN",
  "FAILED",
  "OUT_OF_SCOPE",
  "EMERGENCY_REFERRAL",
  "CANCELLED",
];

export type Tone = "go" | "stop" | "caution" | "unknown" | "live" | "neutral" | "signal";

export function stateTone(s: string | null | undefined): Tone {
  switch (s) {
    case "SUBMITTED":
    case "TRACKING":
      return "go";
    case "FAILED":
      return "stop";
    case "HUMAN_ACTION_REQUIRED":
      return "caution";
    case "SUBMISSION_UNKNOWN":
      return "unknown";
    case "FILING":
    case "APPROVED":
      return "live";
    case "EMERGENCY_REFERRAL":
      return "signal";
    default:
      return "neutral";
  }
}

export const TONE_CLASSES: Record<Tone, string> = {
  go: "bg-go-wash text-go border-go/40",
  stop: "bg-stop-wash text-stop border-stop/40",
  caution: "bg-caution-wash text-caution border-caution/50",
  unknown: "hatch-unknown text-ink2 border-rule2",
  live: "bg-transit-wash text-transit border-transit/40",
  neutral: "bg-neutral-wash text-ink2 border-rule2",
  signal: "bg-signal-wash text-signal-deep border-signal/50",
};

export const TONE_SWATCH: Record<Tone, string> = {
  go: "bg-go",
  stop: "bg-stop",
  caution: "bg-caution",
  unknown: "bg-muted",
  live: "bg-transit",
  neutral: "bg-rule2",
  signal: "bg-signal",
};

export function humanState(s: string) {
  return s.replace(/_/g, " ");
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtMs(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

/** Turn an API-relative storage reference into something the browser can load via the proxy. */
export function evidenceSrc(ref: string) {
  if (/^(https?:|data:|blob:)/.test(ref)) return ref;
  if (ref.startsWith("/api/")) return `/api/bot${ref}`;
  return `/api/bot/api/evidence/${encodeURIComponent(ref)}`;
}

/** Health payload shape is owned by the bot; read it defensively. */
export function normalizeHealth(raw: unknown): Health {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = ((r.providers ?? r.services ?? {}) as Record<string, unknown>) || {};
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null) return r[k];
      if (p[k] !== undefined && p[k] !== null) return p[k];
    }
    return null;
  };
  const asStr = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "on" : "off";
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      return (o.name ?? o.provider ?? o.backend ?? o.mode ?? (o.enabled === false ? "off" : o.enabled ? "on" : null)) as string | null;
    }
    return String(v);
  };
  const tg = pick("telegram", "telegramEnabled", "bot");
  const telegram =
    typeof tg === "boolean" ? tg : tg == null ? null : typeof tg === "string" ? !["off", "disabled", "none", "false"].includes(tg) : Boolean((tg as Record<string, unknown>).enabled ?? (tg as Record<string, unknown>).running ?? true);
  return {
    ok: r.ok !== false && r.status !== "error",
    telegram,
    store: asStr(pick("store", "storeBackend", "db", "surrealdb")),
    sandbox: asStr(pick("sandbox", "sandboxProvider", "daytona")),
    browser: asStr(pick("browser", "browserProvider", "anchor")),
    filingTarget: asStr(pick("filingTarget", "target", "FILING_TARGET")),
    phoenix: asStr(pick("phoenix", "tracing", "arize", "tracer")),
    classifier: asStr(pick("classifier", "llm", "openrouter")),
  };
}

/** Provider health light: degraded fallbacks are amber, missing is grey. */
export function providerState(v: string | null | undefined): "on" | "warn" | "unknown" {
  if (v == null || v === "") return "unknown";
  return /unavailable|fallback|noop|heuristic|bbox/i.test(v) ? "warn" : "on";
}

export const SAFETY_COPY = {
  SUBMITTED: (sr: string) =>
    `Your report was accepted.\n\nReference: ${sr}\n\nI'll keep this reference here so you can check its status later.`,
  HUMAN_ACTION_REQUIRED:
    "Your report is prepared, but I couldn't complete the official submission automatically.\n\nYou can finish it on the official form. I haven't filed anything on your behalf.",
  SUBMISSION_UNKNOWN:
    "The filing attempt finished without a reliable confirmation.\n\nI'm not submitting again automatically because that could create a duplicate. Please check the official portal before retrying.",
  FAILED: "The filing attempt failed before anything was submitted. Nothing was filed on your behalf.",
} as const;
