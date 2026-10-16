/**
 * Adapter for the OFFICIAL MTA Customer Feedback wizard (https://contact.mta.info/s/customer-feedback,
 * Salesforce Experience Cloud + Skuid UI). Category "subway-delay". Map: apps/worker/docs/mta-subway-delay-wizard.md.
 *
 * Path (fixed for this category): Get started → Subways → Complaint or issue → Service and schedule → Delay,
 * then driven by payload.form.transit: line → direction → nearest station (optional) → car number (skipped) →
 * "Tell us more" (required, 4000 chars) + date/time (optional) → Contact details (all optional) → "Submit your feedback".
 * No CAPTCHA, no login, no review step observed.
 *
 * Safety:
 *  - Only payload.form values are typed/selected; page text is data and never changes what we do.
 *  - The final "Submit your feedback" is clicked ONLY when payload.realSubmitAuthorized === true, exactly once,
 *    with state.submitClicked = true set immediately before. Otherwise: dry-run stop (HUMAN_ACTION_REQUIRED, errorCode null).
 *  - Ambiguous/unmatched direction, ambiguous station, or a newly required field ⇒ ctx.ask() the resident live (same page,
 *    options = the official labels); no answer in time ⇒ HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD (station: left empty).
 *  - Contact fields are never invented; the newsletter checkbox and file upload are never touched.
 */
import type { Locator, Page } from "playwright-core";
import { Outcome, SUBWAY_LINES, sanitizeUrl, type TransitDetails } from "../protocol.js";
import { detectCaptcha, detectLogin } from "../safety.js";
import { gotoWithRetries, matchByTokens, nameCandidates, needField, needFieldOutcome, normalizeBorough } from "./common.js";
import { labelOf } from "./fields.js";
import type { AdapterContext, ConfirmResult, FormAdapter } from "./types.js";

export const MTA_FEEDBACK_URL = "https://contact.mta.info/s/customer-feedback";
export const MTA_ALLOWED_HOSTS = ["contact.mta.info", "mta.info", "new.mta.info"];
const FIXED_PATH = ["Subways", "Complaint or issue", "Service and schedule", "Delay"] as const;
const DESCRIPTION_MAX = 4000; // "0/4000" counter on the "Tell us more" textarea (no maxlength attribute)
const SUBMIT_LABEL = "Submit your feedback";

type StepKind = "line" | "direction" | "station" | "additional" | "details" | "contact" | "unknown";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests / the bot's prompts)
// ---------------------------------------------------------------------------

/** Canonical line (SUBWAY_LINES) → wizard button label, e.g. "A" → "A Line". Unknown ⇒ null. */
export function lineButtonLabel(line: string | null | undefined): string | null {
  const l = (line ?? "").trim();
  const hit = SUBWAY_LINES.find((x) => x.toLowerCase() === l.toLowerCase());
  return hit ? `${hit} Line` : null;
}

/**
 * Strip the line prefix: "A Train-Uptown (Inwood-207 St)" → "Uptown (Inwood-207 St)",
 * "S-42 Street Shuttle-Times Sq-42 St" → "Times Sq-42 St", "Staten Island Railway-St. George" → "St. George".
 */
export function directionCore(label: string): string {
  const m = label.match(/^.*?\bTrain\s*-\s*(.+)$/i);
  if (m) return m[1]!.trim();
  const line = [...SUBWAY_LINES].sort((a, b) => b.length - a.length).find((l) => label.startsWith(`${l}-`));
  return line ? label.slice(line.length + 1).trim() : label;
}

/**
 * Pick the direction button for what the resident said. Unique best token overlap wins; zero overlap or a tie ⇒ null.
 * "downtown" → "A Train-Downtown & Queens"; "toward Inwood" → "A Train-Uptown (Inwood-207 St)"; "Brooklyn" on A ⇒ null (ask).
 */
export function matchDirection(said: string | null | undefined, options: string[]): string | null {
  return matchByTokens(said, options, directionCore);
}

/** Candidate station options for what the resident said: exact (normalized) matches, else whole-word contains matches. */
export function stationCandidates(said: string | null | undefined, options: string[]): string[] {
  return nameCandidates(said, options);
}

/** Unique station option or null. */
export function matchStation(said: string | null | undefined, options: string[]): string | null {
  const c = stationCandidates(said, options);
  return c.length === 1 ? c[0]! : null;
}

/** ISO instant → wizard date/time parts in New York local time. Invalid / far future ⇒ null (skip). */
export function nycDateTimeParts(iso: string | null | undefined): { date: string; hour: string; minute: string; ampm: "am" | "pm" } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 10 * 60_000) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute || !parts.dayPeriod) return null;
  return { date: `${Number(parts.month)}/${Number(parts.day)}/${parts.year}`, hour: String(Number(parts.hour)), minute: parts.minute.padStart(2, "0"), ampm: parts.dayPeriod.toLowerCase().startsWith("p") ? "pm" : "am" };
}

/** Reference number on a confirmation page. Requires a digit in the token; never invents one. */
export function parseReference(text: string): string | null {
  const labelled = /(case|reference|confirmation|ticket|tracking|request)\s*(number|#|no\.?|id)?\s*(is)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/gi;
  for (const m of text.matchAll(labelled)) {
    const tok = m[4]!;
    if (/\d/.test(tok)) return tok.replace(/-+$/, "");
  }
  const ty = text.search(/thank you|thanks for|we('| ha)ve received|has been (received|submitted)/i);
  if (ty >= 0) {
    const near = text.slice(Math.max(0, ty - 300), ty + 600).match(/\b\d{8,}\b/);
    if (near) return near[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Visible wizard text without the footer / grid noise. Data only. */
async function wizardText(page: Page): Promise<string> {
  const raw = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/Drag to adjust|^Skip to Main|^MTA - Home$|^Log in$|^English$|^‎$/.test(l));
  const footer = lines.indexOf("THE MTA");
  return (footer > 0 ? lines.slice(0, footer) : lines).join("\n");
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, everyMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return cond().catch(() => false);
}

async function detectStep(page: Page): Promise<StepKind> {
  const t = await wizardText(page);
  if (/Contact details/i.test(t) && (await page.getByRole("button", { name: SUBMIT_LABEL }).count())) return "contact";
  if (/Tell us more/i.test(t) && (await page.locator("textarea").count())) return "details";
  if (/Which station was nearest/i.test(t)) return "station";
  if (/Which direction\?/i.test(t)) return "direction";
  if ((await page.getByRole("button", { name: / Line$/ }).count()) >= 5) return "line";
  if (/Additional Information|Car number/i.test(t)) return "additional";
  return "unknown";
}

function clean(s: string, n = 120) {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

export function createMtaSubwayDelayAdapter(): FormAdapter {
  const filled: {
    line: string | null;
    direction: string | null;
    station: string | null;
    dateTime: string | null;
    breadcrumb: string | null;
    descriptionLen: number;
    descriptionOk: boolean;
    contact: { label: string; value: string }[];
    skipped: string[];
    /** Fields answered live by the resident (ctx.ask). */
    answered: string[];
  } = { line: null, direction: null, station: null, dateTime: null, breadcrumb: null, descriptionLen: 0, descriptionOk: false, contact: [], skipped: [], answered: [] };

  const stepMs = (ctx: AdapterContext) => Math.max(5000, ctx.payload.limits.stepTimeoutMs || 20000);

  async function safetyCheck(ctx: AdapterContext, step: "navigate" | "fill" | "validate") {
    ctx.checkGuard(step);
    const login = await detectLogin(ctx.page);
    if (login.detected) {
      await ctx.shot(step, "login-wall");
      throw new Outcome("HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED", "The MTA form asked for a login. 311Relay never signs in for you.", { ...login });
    }
    const cap = await detectCaptcha(ctx.page);
    if (cap.detected) {
      await ctx.shot(step, "captcha");
      throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", "The MTA form showed a CAPTCHA. 311Relay never solves or bypasses CAPTCHAs; please finish in the live browser view.", { captcha: cap, liveViewUrl: ctx.payload.liveViewUrl });
    }
  }

  /** Click a wizard choice button by its accessible name (exact), waiting for it to render. */
  async function choose(ctx: AdapterContext, name: string) {
    const btn = ctx.page.getByRole("button", { name, exact: true }).first();
    await btn.waitFor({ state: "visible", timeout: stepMs(ctx) });
    await btn.click();
    ctx.action({ kind: "choose", target: name });
    ctx.log("fill", "info", `chose "${name}"`);
  }

  /** Click Continue (waits until enabled) and wait for the wizard to change. */
  async function advance(ctx: AdapterContext, step: "navigate" | "fill", what: string) {
    const page = ctx.page;
    const before = await wizardText(page);
    const cont = page.getByRole("button", { name: /^continue$/i }).first();
    await cont.waitFor({ state: "visible", timeout: stepMs(ctx) });
    const enabled = await waitFor(() => cont.isEnabled(), stepMs(ctx));
    if (!enabled) {
      await ctx.shot(step, `continue-disabled-${what}`);
      needField(`The MTA form would not continue past "${what}" (a required choice is missing).`, { step: what, page: clean(before, 400) });
    }
    await cont.click();
    ctx.action({ kind: "continue", target: "Continue" });
    const changed = await waitFor(async () => (await wizardText(page)) !== before, stepMs(ctx));
    if (!changed) throw new Outcome("FAILED", "BROWSER_ERROR", `The MTA wizard did not move past "${what}" after Continue; nothing was submitted.`);
    await page.waitForTimeout(900); // Skuid renders the next question's buttons asynchronously
    ctx.checkGuard(step);
  }

  async function doLine(ctx: AdapterContext, t: TransitDetails | null) {
    const label = lineButtonLabel(t?.line);
    if (!label) needField(`Which subway line was delayed? (one of: ${SUBWAY_LINES.join(", ")})`, { field: "transit.line", got: t?.line ?? null });
    await choose(ctx, label!);
    filled.line = label!;
    await ctx.shot("fill", "line-chosen", `Line chosen: ${label}`);
    await advance(ctx, "fill", "line");
  }

  async function doDirection(ctx: AdapterContext, t: TransitDetails | null) {
    const page = ctx.page;
    await waitFor(async () => (await page.getByRole("button", { name: /Train-|Shuttle-|Railway-/ }).count()) >= 1, stepMs(ctx));
    const opts = (await page.getByRole("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") ?? (b as HTMLElement).innerText.trim()))).filter(
      (a): a is string => !!a && /Train-|Shuttle-|Railway-/.test(a),
    );
    let pick = matchDirection(t?.direction, opts);
    let byResident = false;
    if (!pick) {
      await ctx.shot("fill", "direction-needed", "Direction options shown by the MTA form");
      const said = t?.direction ? `"${t.direction}" does not clearly match one of them` : "no direction was given";
      const fallback = needFieldOutcome(`Which direction was the ${t?.line ?? ""} train going? The MTA form offers: ${opts.map((o) => `"${directionCore(o)}"`).join(" or ")} (${said}).`, {
        field: "transit.direction",
        options: opts,
        optionsShort: opts.map(directionCore),
        got: t?.direction ?? null,
      });
      if (opts.length < 2) throw fallback;
      const a = await ctx.ask(
        {
          id: "direction",
          field: "direction",
          prompt: `Which way was the ${t?.line ?? ""} train going? ${t?.direction ? `"${clean(t.direction, 60)}" doesn't clearly match one of` : "You didn't say; pick one of"} the MTA form's options:`,
          options: opts.map(directionCore),
          required: true,
        },
        fallback,
      );
      pick = a.optionIndex !== undefined ? (opts[a.optionIndex] ?? null) : matchDirection(a.value, opts);
      if (!pick) throw fallback;
      byResident = true;
      filled.answered.push("direction");
    }
    await choose(ctx, pick!);
    filled.direction = pick!;
    ctx.log("fill", "info", byResident ? `direction chosen by the resident: "${pick}"` : `direction "${t?.direction}" matched "${pick}"`, { options: opts });
    await ctx.shot("fill", "direction-chosen", `Direction chosen: ${pick}`);
    await advance(ctx, "fill", "direction");
  }

  async function doStation(ctx: AdapterContext, t: TransitDetails | null) {
    const page = ctx.page;
    await page.waitForTimeout(1500); // borough labels + picker render late
    const want = t?.station?.trim();
    if (!want) {
      filled.skipped.push("station (not given)");
      ctx.action({ kind: "skip", target: "station" });
      ctx.log("fill", "info", "no station given; leaving the optional station picker empty");
    } else {
      const picker = page.locator('button[aria-haspopup="listbox"]').filter({ visible: true }).first();
      if (!(await picker.count())) {
        filled.skipped.push("station (picker not found)");
        ctx.action({ kind: "skip", target: "station" });
        ctx.log("fill", "warn", "station picker not found; skipping (optional)");
      } else {
        const readOptions = async () => {
          await picker.click();
          const ctl = await picker.getAttribute("aria-controls");
          const list = ctl ? page.locator(`[id="${ctl}"]`) : page.getByRole("listbox").last();
          await waitFor(async () => (await list.getByRole("option").count()) > 0, 5000);
          return { list, options: (await list.getByRole("option").allInnerTexts()).map((s) => s.trim()).filter(Boolean) };
        };
        let { list, options } = await readOptions();
        let cands = stationCandidates(want, options);
        // Same name in two boroughs on one line (e.g. F "7 Av")? Use the borough filter cards above the picker, if offered.
        const boro = normalizeBorough(t?.borough);
        if (cands.length > 1 && boro) {
          await page.keyboard.press("Escape").catch(() => {});
          const card = page.locator('[data-te="skuid__deck"]').getByText(boro, { exact: true }).first();
          if (await card.count()) {
            await card.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1000);
            ({ list, options } = await readOptions());
            cands = stationCandidates(want, options);
          }
        }
        let hit: string | null = cands.length === 1 ? cands[0]! : null;
        if (!hit) {
          // Optional field: ask the resident live; no answer / "Skip" ⇒ leave it empty (the previous behaviour).
          await page.keyboard.press("Escape").catch(() => {});
          const top = cands.slice(0, 5);
          const lineName = filled.line ?? t?.line ?? "this";
          const skipped = new Error("station question unanswered");
          const a = await ctx
            .ask(
              {
                id: "station",
                field: "station",
                prompt: top.length
                  ? `"${clean(want, 60)}" matches more than one station on the MTA's list for the ${lineName}. Which one?`
                  : `I couldn't find "${clean(want, 60)}" on the MTA's station list for the ${lineName}. Type the station as the MTA lists it, or tap Skip.`,
                options: [...top, "Skip"],
                required: false,
              },
              skipped,
            )
            .catch((err) => {
              if (err === skipped) return null;
              throw err;
            });
          const chosen = a && a.optionIndex !== undefined ? (a.optionIndex < top.length ? top[a.optionIndex]! : null) : a && !/^skip$/i.test(a.value) ? matchStation(a.value, options) : null;
          if (chosen) {
            ({ list, options } = await readOptions());
            hit = options.includes(chosen) ? chosen : null;
            if (hit) {
              ctx.log("fill", "info", `station chosen by the resident: "${hit}"`);
              filled.answered.push("station");
            }
            else await page.keyboard.press("Escape").catch(() => {});
          }
        }
        if (hit) {
          await list.getByRole("option", { name: hit, exact: true }).first().click();
          await page.waitForTimeout(500);
          filled.station = hit;
          ctx.action({ kind: "pick", target: hit });
          ctx.log("fill", "info", `station "${want}" matched "${hit}"`, { optionCount: options.length });
        } else {
          await page.keyboard.press("Escape").catch(() => {});
          ctx.action({ kind: "skip", target: "station" });
          filled.skipped.push(`station ("${want}" ${cands.length ? `ambiguous: ${cands.join(" / ")}` : "not on this line's list"})`);
          ctx.log("fill", "warn", `station "${want}" not matched uniquely (optional, left empty)`, { optionCount: options.length, candidates: cands, sample: options.slice(0, 10) });
        }
      }
    }
    await ctx.shot("fill", "station", filled.station ? `Station chosen: ${filled.station}` : "Station left empty (optional)");
    await advance(ctx, "fill", "station");
  }

  async function doDetails(ctx: AdapterContext, t: TransitDetails | null) {
    const page = ctx.page;
    const desc = (ctx.payload.form.description ?? "").trim();
    if (!desc) needField("The MTA form requires a description (\"Tell us more\").", { field: "description" });
    const text = desc.slice(0, DESCRIPTION_MAX);
    if (text.length < desc.length) ctx.log("fill", "warn", `description truncated to ${DESCRIPTION_MAX} chars (form limit)`);
    const crumb = (await wizardText(page)).split("\n").find((l) => /^Details:/.test(l)) ?? null;
    filled.breadcrumb = crumb;
    let ta: Locator = page.getByRole("textbox", { name: /tell us more/i }).first();
    if (!(await ta.count())) ta = page.locator("textarea").first();
    await ta.fill(text);
    filled.descriptionLen = text.length;
    filled.descriptionOk = (await ta.inputValue()) === text;
    ctx.action({ kind: "fill", target: (await labelOf(ta)) || "Tell us more", chars: text.length });

    const parts = nycDateTimeParts(t?.incidentTime);
    if (!parts) {
      filled.skipped.push("date/time (not given)");
    } else {
      const dateInput = page.getByPlaceholder("M/D/YYYY").first();
      const box = page.locator('[data-te="skuid__datetime"]').filter({ has: dateInput }).first();
      try {
        await dateInput.click();
        await dateInput.fill(parts.date);
        await dateInput.press("Tab");
        await page.waitForTimeout(400);
        const sels = box.locator('button[aria-haspopup="listbox"]');
        if ((await sels.count()) < 3) throw new Error(`expected 3 time pickers, found ${await sels.count()}`);
        const wantVals = [parts.hour, parts.minute, parts.ampm];
        for (let k = 0; k < 3; k++) {
          const sel = sels.nth(k);
          await sel.click();
          const ctl = await sel.getAttribute("aria-controls");
          const list = ctl ? page.locator(`[id="${ctl}"]`) : page.getByRole("listbox").last();
          await list.getByRole("option", { name: wantVals[k]!, exact: true }).first().click({ timeout: 5000 });
          await page.waitForTimeout(300);
        }
        const shown = [await dateInput.inputValue(), ...(await sels.allInnerTexts()).map((s) => s.split("\n")[0]!.trim())];
        filled.dateTime = `${shown[0]} ${shown[1]}:${shown[2]} ${shown[3]}`;
        if (shown[0] !== parts.date) throw new Error(`date shows "${shown[0]}"`);
        ctx.action({ kind: "fill", target: "date/time", chars: filled.dateTime.length });
        ctx.log("fill", "info", `incident time set to ${filled.dateTime} (New York time)`);
      } catch (err) {
        // Optional field: leave it blank rather than half-set.
        await page.keyboard.press("Escape").catch(() => {});
        await dateInput.fill("").catch(() => {});
        filled.dateTime = null;
        filled.skipped.push("date/time (picker failed)");
        ctx.log("fill", "warn", `could not set the optional date/time; left blank: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      }
    }
    await ctx.shot("fill", "details-filled", "Description and time filled");
    await advance(ctx, "fill", "details");
  }

  async function doContact(ctx: AdapterContext) {
    const page = ctx.page;
    const f = ctx.payload.form;
    let parts = (f.contactName ?? "").trim().split(/\s+/).filter(Boolean);
    const nameParts = () => ({ first: parts[0] ?? null, last: parts.length > 1 ? parts.slice(1).join(" ") : null });
    let email = f.contactEmail;
    let phone = f.contactPhone;
    const fields: { re: RegExp; value: () => string | null; what: string }[] = [
      { re: /^first name/i, value: () => nameParts().first, what: "first name" },
      { re: /^last name/i, value: () => nameParts().last, what: "last name" },
      { re: /^email/i, value: () => email, what: "email" },
      { re: /^phone/i, value: () => phone, what: "phone" },
    ];
    /** A field the form now requires and the payload lacks: ask the resident live (never invent). */
    const askFor = async (what: string, label: string) => {
      const fallback = needFieldOutcome(`The MTA form now requires your ${what}.`, { field: what, label });
      if (what === "first name" || what === "last name") {
        const a = await ctx.ask({ id: "contact_name", field: "contact_name", prompt: "The MTA form now requires your name. What first and last name should go on the complaint?", required: true }, fallback);
        parts = a.value.split(/\s+/).filter(Boolean);
        if (!nameParts()[what === "first name" ? "first" : "last"]) throw fallback;
      } else if (what === "email") {
        const a = await ctx.ask({ id: "contact_email", field: "contact_email", prompt: "The MTA form now requires an email address so they can reply. Which email should I use?", required: true }, fallback);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.value)) throw fallback;
        email = a.value;
      } else {
        const a = await ctx.ask({ id: "contact_phone", field: "free_text", prompt: "The MTA form now requires a phone number. Which number should I use?", required: true }, fallback);
        if (!/\d{7,}/.test(a.value.replace(/\D/g, ""))) throw fallback;
        phone = a.value;
      }
    };
    for (const fd of fields) {
      const box = page.getByRole("textbox", { name: fd.re }).first();
      if (!(await box.count())) {
        if (fd.value()) ctx.log("fill", "info", `the MTA form has no ${fd.what} field; not sent`);
        continue;
      }
      const label = (await labelOf(box)) || fd.what;
      const required = !/optional/i.test(label) && (/required|\*/i.test(label) || (await box.evaluate((e) => (e as HTMLInputElement).required || e.getAttribute("aria-required") === "true")));
      if (!fd.value() && required) await askFor(fd.what, label);
      const value = fd.value();
      if (!value) continue;
      await box.fill(value);
      filled.contact.push({ label, value });
      ctx.action({ kind: "fill", target: label, chars: value.length });
    }
    // Any other visible required free-text input we do not know about ⇒ ask, never guess.
    const unknownRequired = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input,textarea"))
        .filter((e) => (e as HTMLElement).offsetParent !== null && (e as HTMLInputElement).type !== "file" && (e as HTMLInputElement).type !== "checkbox")
        .map((e) => ({ label: ((e as HTMLInputElement).labels?.[0]?.innerText ?? "").replace(/\s+/g, " ").trim(), value: (e as HTMLInputElement).value, req: (e as HTMLInputElement).required || e.getAttribute("aria-required") === "true" }))
        .filter((x) => !x.value && (x.req || /\(required\)/i.test(x.label)) && !/optional/i.test(x.label)),
    );
    if (unknownRequired.length) {
      const fallback = needFieldOutcome(`The MTA form now requires: ${unknownRequired.map((u) => u.label || "an unlabeled field").join(", ")}.`, { fields: unknownRequired });
      for (const [i, u] of unknownRequired.slice(0, 3).entries()) {
        if (!u.label) throw fallback;
        const box = page.getByLabel(u.label, { exact: true }).first();
        if (!(await box.count())) throw fallback;
        const a = await ctx.ask({ id: `field-${i + 1}`, field: "free_text", prompt: `The MTA form now requires "${clean(u.label, 80)}", which I don't have from you. What should I enter?`, required: true }, fallback);
        if (!a.value) throw fallback;
        await box.fill(a.value);
        filled.contact.push({ label: u.label, value: a.value });
        ctx.action({ kind: "fill", target: clean(u.label, 60), chars: a.value.length });
      }
      if (unknownRequired.length > 3) throw fallback;
    }
    ctx.log("fill", "info", "contact step filled from the resident's own details only (newsletter box and file upload untouched)", { filled: filled.contact.map((c) => c.label) });
  }

  return {
    id: "mta-subway-delay",

    async navigate(ctx) {
      const url = ctx.payload.formUrl || MTA_FEEDBACK_URL;
      ctx.log("navigate", "info", "opening the official MTA Customer Feedback form", { url: sanitizeUrl(url) });
      await gotoWithRetries(ctx, url, 'button:has-text("Get started")');
      await ctx.page.waitForTimeout(1500);
      await ctx.shot("navigate", "mta-feedback-loaded");
      await safetyCheck(ctx, "navigate");
      await ctx.page.getByRole("button", { name: /^get started$/i }).first().click();
      ctx.action({ kind: "click", target: "Get started" });
      for (const choice of FIXED_PATH) {
        const btn = ctx.page.getByRole("button", { name: choice, exact: true }).first();
        await btn.waitFor({ state: "visible", timeout: stepMs(ctx) });
        await btn.click();
        ctx.action({ kind: "choose", target: choice });
        ctx.log("navigate", "info", `chose "${choice}"`);
        await advance(ctx, "navigate", choice);
      }
      await ctx.shot("navigate", "topic-chosen", `Topic chosen: ${FIXED_PATH.join(" › ")}`);
    },

    async inspect(ctx) {
      await safetyCheck(ctx, "navigate");
      const kind = await detectStep(ctx.page);
      if (kind !== "line") {
        await ctx.shot("inspect", "unexpected-step");
        needField(`The MTA form changed: expected the subway line question after "Delay" but found something else.`, { page: clean(await wizardText(ctx.page), 500) });
      }
      return { requiredKnown: ["line", "direction", "Tell us more"] };
    },

    async fill(ctx) {
      const t = ctx.payload.form.transit ?? null;
      const seen = new Set<StepKind>();
      for (let i = 0; i < 10; i++) {
        await safetyCheck(ctx, "fill");
        const kind = await detectStep(ctx.page);
        if (seen.has(kind) && kind !== "unknown") throw new Outcome("FAILED", "BROWSER_ERROR", `The MTA wizard returned to the "${kind}" step; nothing was submitted.`);
        seen.add(kind);
        ctx.log("fill", "info", `wizard step: ${kind}`);
        if (kind === "line") await doLine(ctx, t);
        else if (kind === "direction") await doDirection(ctx, t);
        else if (kind === "station") await doStation(ctx, t);
        else if (kind === "additional") {
          filled.skipped.push("car number (optional, not known)");
          await ctx.shot("fill", "additional-info", "Optional car number left empty");
          await advance(ctx, "fill", "additional information");
        } else if (kind === "details") await doDetails(ctx, t);
        else if (kind === "contact") {
          await doContact(ctx);
          return;
        } else {
          await ctx.shot("fill", "unknown-step");
          const text = clean(await wizardText(ctx.page), 400);
          needField(`The MTA form showed a question 311Relay does not know how to answer: "${text}".`, { page: text });
        }
      }
      throw new Outcome("FAILED", "BROWSER_ERROR", "The MTA wizard had more steps than expected; nothing was submitted.");
    },

    async validate(ctx) {
      const page = ctx.page;
      const problems: string[] = [];
      await safetyCheck(ctx, "validate");
      if ((await detectStep(page)) !== "contact") problems.push("not on the final contact/submit step");
      const crumb = filled.breadcrumb ?? "";
      const line = ctx.payload.form.transit?.line ?? "";
      if (!crumb.includes(` ${line}`) && !crumb.startsWith(`Details: ${line}`)) problems.push(`summary "${crumb}" does not show line ${line}`);
      if (filled.direction && !crumb.includes(directionCore(filled.direction))) problems.push(`summary "${crumb}" does not show direction "${directionCore(filled.direction)}"`);
      if (filled.station && !crumb.includes(filled.station)) problems.push(`summary "${crumb}" does not show station "${filled.station}"`);
      if (!filled.descriptionOk) problems.push("description read-back did not match");
      for (const c of filled.contact) {
        const box = page.getByRole("textbox", { name: c.label, exact: true }).first();
        const v = (await box.count()) ? await box.inputValue() : null;
        if (v !== c.value) problems.push(`${c.label}: expected "${c.value}", found "${v}"`);
      }
      const newsletter = page.getByRole("checkbox").first();
      if ((await newsletter.count()) && (await newsletter.isChecked().catch(() => false))) problems.push("newsletter checkbox is checked (must stay unchecked)");
      const submit = page.getByRole("button", { name: SUBMIT_LABEL, exact: true });
      if (!(await submit.count()) || !(await submit.first().isEnabled())) problems.push(`"${SUBMIT_LABEL}" button not available`);
      const summary = { line: filled.line, direction: filled.direction, station: filled.station, dateTime: filled.dateTime, breadcrumb: filled.breadcrumb, descriptionChars: filled.descriptionLen, contactFields: filled.contact.map((c) => c.label), skipped: filled.skipped };
      ctx.log("validate", problems.length ? "warn" : "info", problems.length ? "verification problems" : "all chosen values reflected on the form", { ...summary, problems });
      await ctx.shot("validate", "final-pre-submit", `Final MTA page, filled, before "${SUBMIT_LABEL}"`);
      return { ok: problems.length === 0, problems };
    },

    async submit(ctx) {
      const page = ctx.page;
      if (ctx.payload.realSubmitAuthorized !== true) {
        ctx.log("submit", "warn", `dry run: realSubmitAuthorized is not true; NOT clicking "${SUBMIT_LABEL}"`);
        // After a live answer, caption the evidence with the form's OWN summary line (proves what the form recorded).
        // Visual only (pointer-events: none, removed right after the screenshot); no form field is touched.
        const caption = filled.answered.length && filled.breadcrumb ? `311Relay dry run (not submitted). The MTA form's own summary: ${filled.breadcrumb}` : null;
        if (caption)
          await page
            .evaluate((text) => {
              const d = document.createElement("div");
              d.id = "relay-evidence-caption";
              d.textContent = text;
              d.setAttribute("style", "position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;background:#fff3cd;color:#000;font:600 15px/1.4 system-ui,sans-serif;padding:10px 16px;border-bottom:2px solid #c69500");
              document.body.appendChild(d);
            }, caption)
            .catch(() => {});
        await ctx.shot("submit", "dry-run-stop", caption ? `Dry run: everything filled, stopped before "${SUBMIT_LABEL}" (${filled.breadcrumb})` : `Dry run: everything filled, stopped before "${SUBMIT_LABEL}"`);
        if (caption) await page.evaluate(() => document.getElementById("relay-evidence-caption")?.remove()).catch(() => {});
        await ctx.saveHtml("submit", "dry-run-stop");
        ctx.action({ kind: "stop", target: SUBMIT_LABEL });
        throw new Outcome("HUMAN_ACTION_REQUIRED", null, "Stopped before the final Submit (dry run). Everything is filled in.", {
          dryRun: true,
          liveViewUrl: ctx.payload.liveViewUrl,
          filled: { line: filled.line, direction: filled.direction, station: filled.station, dateTime: filled.dateTime, breadcrumb: filled.breadcrumb, skipped: filled.skipped, answeredLive: filled.answered },
        });
      }
      const btn = page.getByRole("button", { name: SUBMIT_LABEL, exact: true }).first();
      await btn.waitFor({ state: "visible", timeout: stepMs(ctx) });
      if (!(await btn.isEnabled())) throw new Outcome("FAILED", "BROWSER_ERROR", `"${SUBMIT_LABEL}" is disabled; nothing was submitted.`);
      ctx.log("submit", "warn", `realSubmitAuthorized=true: clicking "${SUBMIT_LABEL}" exactly once`);
      ctx.state.submitClicked = true;
      ctx.action({ kind: "submit", target: SUBMIT_LABEL });
      await btn.click({ noWaitAfter: true, timeout: 10_000 });
    },

    async confirm(ctx): Promise<ConfirmResult> {
      const page = ctx.page;
      const done = /thank you|thanks for|we('| ha)ve received|has been (received|submitted)|case (number|#)|reference (number|#)|confirmation (number|#)/i;
      const settled = await waitFor(
        async () => done.test(await wizardText(page)) || (await page.getByRole("button", { name: SUBMIT_LABEL, exact: true }).count()) === 0,
        Math.max(30_000, stepMs(ctx) * 2),
        500,
      );
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      ctx.checkGuard("confirm");
      const text = await wizardText(page);
      await ctx.shot("confirm", "mta-confirmation", "MTA page after Submit");
      await ctx.saveHtml("confirm", "mta-confirmation");
      ctx.log("confirm", "info", "page text after submit (data only)", { settled, text: text.slice(0, 1500) });
      const stillOnForm = (await page.getByRole("button", { name: SUBMIT_LABEL, exact: true }).count()) > 0;
      if (stillOnForm && !done.test(text)) {
        throw new Outcome("SUBMISSION_UNKNOWN", "NO_CONFIRMATION", `Submit was clicked but the MTA page did not confirm receipt (still showing "${SUBMIT_LABEL}"). It may or may not have been received; no automatic retry.`, { pageText: text.slice(0, 600) });
      }
      const ref = parseReference(text);
      const thanks = done.test(text);
      const lines = text.split("\n");
      const idx = lines.findIndex((l) => done.test(l) || (ref ? l.includes(ref) : false));
      const confirmationText = thanks || ref ? lines.slice(Math.max(0, idx - 2), idx + 8).join("\n").slice(0, 1200) || text.slice(0, 1200) : null;
      const url = sanitizeUrl(page.url());
      return { officialRequestNumber: ref, confirmationText, receiptUrl: url && !/\/s\/customer-feedback\/?$/.test(url) ? url : null };
    },
  };
}
