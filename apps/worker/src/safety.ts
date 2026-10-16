import type { Page } from "playwright-core";

/**
 * Safety probes. They only READ the page; page text is treated as data, never as instructions.
 * Each returns evidence-friendly details for the result/event log.
 */

const CAPTCHA_SELECTORS = [".g-recaptcha", 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', "[data-sitekey]", 'iframe[src*="challenges.cloudflare.com"]', ".cf-turnstile"];
const CAPTCHA_TEXT = /verify you are human|i'?m not a robot|i’m not a robot/i;

export interface CaptchaDetection {
  detected: boolean;
  selectors: string[];
  textMatch: string | null;
  /** reCAPTCHA v3 / invisible badge only (no checkbox): still a hard stop — the server will verify a token. */
  kind: "recaptcha" | "hcaptcha" | "turnstile" | "text" | null;
}

export async function detectCaptcha(page: Page): Promise<CaptchaDetection> {
  const res = await page
    .evaluate(
      ({ sels }) => {
        const hits: string[] = [];
        for (const s of sels) if (document.querySelector(s)) hits.push(s);
        const text = (document.body?.innerText ?? "").slice(0, 20000);
        return { hits, text };
      },
      { sels: CAPTCHA_SELECTORS },
    )
    .catch(() => ({ hits: [] as string[], text: "" }));
  // Frames too (reCAPTCHA renders in iframes; their URL is enough).
  for (const f of page.frames()) {
    const u = f.url();
    if (/recaptcha/i.test(u) && !res.hits.includes('iframe[src*="recaptcha"]')) res.hits.push('iframe[src*="recaptcha"]');
    if (/hcaptcha/i.test(u) && !res.hits.includes('iframe[src*="hcaptcha"]')) res.hits.push('iframe[src*="hcaptcha"]');
  }
  const m = res.text.match(CAPTCHA_TEXT);
  const kind = res.hits.some((h) => h.includes("hcaptcha"))
    ? "hcaptcha"
    : res.hits.some((h) => h.includes("cloudflare") || h.includes("turnstile"))
      ? "turnstile"
      : res.hits.length
        ? "recaptcha"
        : m
          ? "text"
          : null;
  return { detected: res.hits.length > 0 || !!m, selectors: res.hits, textMatch: m ? m[0] : null, kind };
}

export interface LoginDetection {
  detected: boolean;
  passwordInputs: number;
  textMatch: string | null;
}

export async function detectLogin(page: Page): Promise<LoginDetection> {
  const r = await page
    .evaluate(() => {
      const pw = Array.from(document.querySelectorAll('input[type="password"]')).filter((e) => (e as HTMLElement).offsetParent !== null).length;
      const text = (document.body?.innerText ?? "").slice(0, 20000);
      return { pw, text };
    })
    .catch(() => ({ pw: 0, text: "" }));
  const m = r.text.match(/(please|you must|required to)\s+(sign|log)\s*in|sign in to continue|log in to continue|login required/i);
  return { detected: r.pw > 0 || !!m, passwordInputs: r.pw, textMatch: m ? m[0] : null };
}

export interface RequiredField {
  name: string;
  id: string;
  tag: string;
  type: string | null;
  label: string | null;
}

/** Visible required inputs/selects/textareas whose name/id is NOT in the adapter's known set. */
export async function unexpectedRequiredFields(page: Page, knownNames: string[]): Promise<RequiredField[]> {
  const all = await page
    .evaluate(() => {
      const out: { name: string; id: string; tag: string; type: string | null; label: string | null }[] = [];
      for (const el of Array.from(document.querySelectorAll("input,select,textarea"))) {
        const e = el as HTMLInputElement;
        if (e.type === "hidden" || e.type === "submit" || e.type === "button") continue;
        const required = e.required || e.getAttribute("aria-required") === "true";
        if (!required) continue;
        if (e.offsetParent === null && e.type !== "radio") continue;
        const lbl = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
        out.push({ name: e.name ?? "", id: e.id ?? "", tag: e.tagName.toLowerCase(), type: e.getAttribute("type"), label: lbl?.textContent?.trim().slice(0, 80) ?? null });
      }
      return out;
    })
    .catch(() => [] as RequiredField[]);
  const known = new Set(knownNames);
  return all.filter((f) => !known.has(f.name) && !known.has(f.id));
}
