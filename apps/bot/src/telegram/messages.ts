/**
 * All user-facing copy (design doc §6). Messages use Telegram HTML parse mode;
 * every interpolated user/LLM/public-data string goes through esc().
 */
import type { ComplaintDraft, DuplicateCandidate, FilingOutcome, OfficialRequest } from "../core/contracts.js";
import { NYC311_CHECK_STATUS_URL, NYC311_REPORT_URL, emergencyText, getCategory, helpText, manualGuidance } from "../core/knowledge.js";

export function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export const M = {
  start: () =>
    [
      "Hey, I'm 311Relay 👋",
      "",
      "Drop a photo or describe what's wrong — a stuck train, a broken something, whatever you ran into — and I'll figure out where it has to be reported and file it for you.",
      "",
      "You review every report before it's sent.",
      "",
      "For emergencies, call 911.",
    ].join("\n"),
  help: () => esc(helpText()),
  reportPrompt: () => "Okay. Send a photo or describe the problem.",
  emergency: () => esc(emergencyText()),
  outOfScope: (triage: "OUT_OF_SCOPE" | "UNCLEAR", text: string | null) => esc(manualGuidance(triage, text)),
  clarify: (question: string | null) => esc(question ?? "Could you tell me a bit more about what happened?"),
  needDescription: () => "What's the problem? A photo or a short description works.",
  analyzing: () => "Got it, taking a look… 🔎",
  classified: (label: string) => `Looks like a possible ${esc(label.toLowerCase())}.`,
  noted: () => "Thanks, I've added that to the report.",
  askLocation: () => "Can you share the location or nearest intersection?\n\nTap <b>📍 Share location</b> below, or type an address like “W 42nd St & 7th Ave, Manhattan”.",
  locationGot: () => "Got it. I'll use the location you shared.\n\nBefore reporting, I'm checking whether a similar issue may already have been reported nearby.",
  locationNotFound: () => "I couldn't find that address in NYC. Could you share a 📍 pin, or type a street address with the borough?",
  outsideNyc: () => "That location looks like it's outside New York City, so I can't file this one.\n\nIf it's in NYC, share the pin again or type the address.",
  openDataDown: () => "I couldn't check NYC Open Data for similar reports right now, so I'm continuing without the duplicate check.",
  duplicate: (cands: DuplicateCandidate[], dataAsOf: string | null, categoryLabel: string) => {
    const c = cands[0]!;
    const lines = [
      `I found a possibly related report near this location.`,
      "",
      `<b>Type:</b> ${esc(c.complaintType)}${c.descriptor ? ` (${esc(c.descriptor)})` : ""}`,
      c.incidentAddress ? `<b>Near:</b> ${esc(c.incidentAddress)}${c.distanceMeters != null ? ` (~${Math.round(c.distanceMeters)} m away)` : ""}` : null,
      `<b>Status:</b> ${esc(c.status ?? "Unknown")}`,
      `<b>Reported:</b> ${ago(c.ageDays)}`,
      cands.length > 1 ? `\n…and ${cands.length - 1} more nearby.` : null,
      "",
      `<i>This might not be the same problem. Public data as of ${esc(fmtDate(dataAsOf) ?? "recently")}; it can be delayed or incomplete.</i>`,
      "",
      "Would you like to review the existing request or continue preparing a new report?",
    ];
    return lines.filter((l) => l !== null).join("\n");
  },
  draftChanged: () => "The draft changed since you saw it. Here's the latest:",
  needName: () =>
    "The official form needs your first and last name. Send <code>/name First Last</code> to continue.",
  nameSaved: (name: string) => `Thanks, I'll use <b>${esc(name)}</b> as the contact name on official forms.`,
  filingNow: () => "Filing now… I'll send updates. ⏳",
  progress: (t: string) => `⚙️ ${esc(t)}`,
  cancelled: () => "Okay, I cancelled that draft. Nothing was filed.\n\nSend a photo or description anytime to start a new report.",
  nothingToCancel: () => "There's no active draft to cancel.",
  editPrompt: (transit = false) =>
    transit
      ? "Sure. What should I change? Tell me the correct line, direction, station, time or description."
      : "Sure. What should I change? Tell me the correct details (description or location), or send a new photo.",
  dupReview: () => "You can look up the existing request on NYC311. If it's the same problem, there's no need to file again. Tap <b>Continue with new report</b> if it's different.",
  statusUsage: () => "Send <code>/status &lt;service request number&gt;</code>, or tap <b>Check status</b> on a filed report.",
  error: () => "Something went wrong on my side; nothing was filed.",
  voiceUnsupported: () => "I can't understand voice messages yet. Could you type a short description instead?",
  invalidImage: () => "I couldn't read that image. Could you describe the problem in a few words?",
  busy: () => "I'm already working on this report. Hang tight. ⏳",
  noActive: () => "There's no active draft right now. Send a photo or description to start one.",

  recording: (ref: string) => `🎥 Recording of the filing session for <b>${esc(ref)}</b> — this is what the browser did on your behalf.`,

  // ---- subway-delay (MTA Customer Feedback) ----
  askTransit: (missing: ("line" | "direction")[]) =>
    missing.includes("line") ? "Which line was it? (for example A, 7 or L)" : "Which direction were you heading — uptown or downtown, or which terminal?",
  askDirection: (line: string, said: string | null) =>
    `Which way was the ${esc(/^[0-9A-Z]$/.test(line) ? line : line)} going? The MTA form lists:${said ? `\n<i>(“${esc(said)}” doesn't clearly match one of them.)</i>` : ""}`,
  directionSet: (label: string) => `Got it: <b>${esc(label)}</b>.`,
  askTime: () => "When did this happen?",
  askTimeTyped: () => "What time was it? For example <code>8:30 am</code>.",
  timeSet: (when: string) => `Got it: <b>${esc(when)}</b>.`,
  noDuplicateCheckMta: () => "Subway complaints go straight to the MTA, so there's no NYC311 duplicate check.",
  mtaAlert: (header: string) => `🚇 <b>MTA currently reports:</b> ${esc(header)}`,
  noMtaAlert: (line: string) => `No active MTA delay alert for the ${esc(line)} right now (you can still file).`,
  mtaAlertsDown: () => "<i>I couldn't reach the live MTA alerts feed right now (you can still file).</i>",
  emailSaved: (email: string) => `Thanks, I'll pass <b>${esc(email)}</b> to official forms that ask for an email (the MTA replies there).`,
  emailUsage: () => "Please send a valid email, like <code>/email jane@example.com</code>. It's optional and only used on official forms.",
  mtaSubmitted: (sr: string) => `✅ The MTA accepted your complaint. Reference: <b>${esc(sr)}</b>. They usually reply by email if you provided one.`,
  mtaDryRun: (liveViewUrl: string | null) =>
    [
      "🧪 Dry run: I filled the MTA form completely and stopped before Submit (ALLOW_REAL_SUBMIT is off). Screenshot attached.",
      "",
      "Nothing was sent to the MTA.",
      liveViewUrl ? `\nIf you want to send it yourself, the same browser is open for a few minutes: ${esc(liveViewUrl)}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  mtaStatus: (sr: string, filed: string | null) =>
    `<b>MTA case ${esc(sr)}</b>${filed ? `, filed ${esc(filed)}` : ""}.\nThe MTA replies by email; there is no public status lookup for MTA complaints.`,

  submitted: (o: FilingOutcome) =>
    [
      "✅ Your report was accepted.",
      "",
      `Service request: <b>${esc(o.officialRequestNumber)}</b>`,
      "",
      "I'll keep this reference here so you can check its status later.",
    ].join("\n"),
  humanAction: (o: FilingOutcome, finishUrl: string) =>
    [
      "Your report is prepared, but I couldn't complete the official submission automatically.",
      "",
      "You can finish it on the official site. I haven't filed anything on your behalf.",
      o.errorCode ? `\n<i>${esc(filingReason(o.errorCode))}</i>` : null,
      `\n${esc(finishUrl)}`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  liveView: () => "You can also take over the same browser session for a few minutes using the button below.",
  unknown: (_o: FilingOutcome) =>
    [
      "The filing attempt finished without a reliable confirmation.",
      "",
      "I'm not submitting again automatically because that could create a duplicate. Please check the official portal before retrying.",
    ].join("\n"),
  failed: (o: FilingOutcome) => `I couldn't complete the filing: ${esc(filingReason(o.errorCode).replace(/\.$/, ""))}. Nothing was submitted. You can try again from the draft.`,

  myReports: (drafts: ComplaintDraft[], requests: OfficialRequest[]) => {
    if (!drafts.length && !requests.length) return "You don't have any reports yet. Send a photo or description to start one.";
    const lines = [drafts.length > 5 ? "<b>Your last 5 reports</b>" : "<b>Your reports</b>", ""];
    for (const d of drafts.slice(0, 5)) {
      const cat = getCategory(d.category)?.label ?? "Uncategorized";
      const where = d.transit?.line
        ? `${/^[0-9A-Z]$/.test(d.transit.line) ? `${d.transit.line} train` : d.transit.line}${d.transit.direction ? `, ${d.transit.direction}` : ""}`
        : (d.location.address ?? (d.location.latitude != null ? `${d.location.latitude.toFixed(4)}, ${d.location.longitude?.toFixed(4)}` : null));
      const sr = d.officialRequestNumber ? ` · SR <code>${esc(d.officialRequestNumber)}</code>` : "";
      const dryRun = d.status === "HUMAN_ACTION_REQUIRED" && /dry-run/i.test(d.statusReason ?? "") ? "dry run, nothing sent" : null;
      lines.push(`• ${esc(cat)}${where ? ` · ${esc(where)}` : ""} · <i>${esc(dryRun ?? humanStatus(d.status))}</i>${sr} · ${esc(fmtWhen(d.createdAt))}`);
    }
    const unlisted = requests.filter((r) => !drafts.some((d) => d.officialRequestNumber === r.officialRequestNumber));
    for (const r of unlisted) lines.push(`• SR <code>${esc(r.officialRequestNumber)}</code> · ${esc(r.status ?? "status unknown")}`);
    lines.push("", "Use /status &lt;number&gt; to check a request.");
    return lines.join("\n");
  },
  status: (sr: string, s: { status: string | null; detail?: string | null; source?: string | null; found: boolean }) =>
    s.found
      ? [`<b>Service request ${esc(sr)}</b>`, `Status: <b>${esc(s.status ?? "Unknown")}</b>`, s.detail ? esc(s.detail) : null, s.source && SOURCE_LABEL[s.source] !== "" ? `<i>Source: ${esc(SOURCE_LABEL[s.source] ?? s.source)}</i>` : null]
          .filter(Boolean)
          .join("\n")
      : `I couldn't find status for <code>${esc(sr)}</code> yet. New requests can take a while to appear in public data. You can also check ${NYC311_CHECK_STATUS_URL}`,
};

const FILING_REASONS: Record<string, string> = {
  CAPTCHA: "The form asks you to prove you're human (CAPTCHA). I never bypass those.",
  LOGIN_REQUIRED: "The form asks you to sign in. I don't log in on your behalf.",
  UNEXPECTED_REQUIRED_FIELD: "The form asked for information I don't have from you.",
  OFF_ALLOWLIST_NAVIGATION: "The form tried to leave the official site allowlist, so I stopped.",
  FORM_REJECTED: "the official form rejected the report details",
  NO_CONFIRMATION: "no official confirmation number was shown",
  CONNECTION_LOST_AFTER_SUBMIT: "the connection dropped right after submitting",
  NAVIGATION_FAILED: "the official form could not be opened",
  TIMEOUT: "the filing took too long and was stopped",
  BROWSER_ERROR: "the cloud browser could not be started",
  WORKER_CRASH: "the isolated filing worker stopped unexpectedly",
  SANDBOX_ERROR: "the isolated filing environment could not be started",
};
export function filingReason(code: string | null | undefined): string {
  return (code && FILING_REASONS[code]) || "an unexpected error";
}

export function fmtDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" }) : s;
}

const SOURCE_LABEL: Record<string, string> = { "open-data": "NYC Open Data (311 Service Requests)", unknown: "" };

export function ago(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d === 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d} days ago`;
}

/** "Oct 16, 1:02 PM" in New York time. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

export function humanStatus(s: ComplaintDraft["status"]): string {
  const map: Record<ComplaintDraft["status"], string> = {
    RECEIVED: "received",
    TRIAGING: "reviewing",
    OUT_OF_SCOPE: "not supported",
    EMERGENCY_REFERRAL: "emergency referral",
    NEEDS_INFORMATION: "needs info",
    DUPLICATE_REVIEW: "checking duplicates",
    READY_FOR_APPROVAL: "waiting for your approval",
    APPROVED: "approved",
    FILING: "filing",
    HUMAN_ACTION_REQUIRED: "needs you to finish",
    SUBMISSION_UNKNOWN: "result unknown",
    FAILED: "filing failed",
    SUBMITTED: "submitted",
    TRACKING: "submitted · tracking",
    CANCELLED: "cancelled",
  };
  return map[s];
}

export { NYC311_REPORT_URL, NYC311_CHECK_STATUS_URL };
