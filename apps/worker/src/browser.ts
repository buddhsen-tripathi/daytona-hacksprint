import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright-core";
import { hostAllowed, sanitizeUrl, type FilingPayload } from "./protocol.js";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

export interface GuardState {
  /** Set when a top-level navigation to a non-allowlisted host was attempted (and aborted). */
  offAllowlist: boolean;
  offAllowlistUrl: string | null;
  /** Set when a main-frame navigation request failed (e.g. socket destroyed after submit). */
  mainFrameFailures: { url: string; method: string; errorText: string; at: number }[];
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  guard: GuardState;
  mode: "cdp" | "local";
  /** Detach from the browser. Remote (Anchor) sessions are left OPEN so the user can take over in the live view. */
  release(): Promise<void>;
}

function isHttp(u: string) {
  return u.startsWith("http://") || u.startsWith("https://");
}

export async function openBrowser(payload: FilingPayload, log: (msg: string, data?: Record<string, unknown>) => void): Promise<BrowserSession> {
  const stepTimeout = payload.limits.stepTimeoutMs || 20000;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let mode: "cdp" | "local";

  if (payload.cdpUrl) {
    mode = "cdp";
    browser = await chromium.connectOverCDP(payload.cdpUrl, { timeout: Math.max(stepTimeout, 30000) });
    context = browser.contexts()[0] ?? (await browser.newContext());
    page = context.pages()[0] ?? (await context.newPage());
    log("connected to remote browser over CDP", { contexts: browser.contexts().length });
  } else {
    mode = "local";
    const executablePath = process.env.CHROME_PATH || [MAC_CHROME, ...LINUX_CANDIDATES].find((p) => existsSync(p));
    browser = await chromium.launch({ headless: process.env.HEADLESS !== "0", ...(executablePath ? { executablePath } : {}) });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    log("launched local Chrome", { headless: process.env.HEADLESS !== "0", executablePath: executablePath ?? "playwright default" });
  }

  if (Object.keys(payload.extraHeaders ?? {}).length) await context.setExtraHTTPHeaders(payload.extraHeaders);
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  page.setDefaultTimeout(stepTimeout);
  page.setDefaultNavigationTimeout(stepTimeout);

  const guard: GuardState = { offAllowlist: false, offAllowlistUrl: null, mainFrameFailures: [] };
  const allowed = payload.allowedHosts;

  // Navigation guard 1: abort top-level navigations to non-allowlisted hosts before they leave the browser.
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && isHttp(url) && !hostAllowed(new URL(url).hostname, allowed)) {
      guard.offAllowlist = true;
      guard.offAllowlistUrl = sanitizeUrl(url);
      log("blocked off-allowlist navigation", { url: guard.offAllowlistUrl });
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });

  // Navigation guard 2: redirect hops are not always routed — flag any main-frame navigation request off the allowlist.
  page.on("request", (req) => {
    const url = req.url();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && isHttp(url) && !hostAllowed(new URL(url).hostname, allowed) && !guard.offAllowlist) {
      guard.offAllowlist = true;
      guard.offAllowlistUrl = sanitizeUrl(url);
      log("off-allowlist navigation request (redirect)", { url: guard.offAllowlistUrl });
    }
  });

  // Navigation guard 3 (backstop for anything the router missed).
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (isHttp(url) && !hostAllowed(new URL(url).hostname, allowed)) {
      guard.offAllowlist = true;
      guard.offAllowlistUrl = sanitizeUrl(url);
      log("main frame is on a non-allowlisted host", { url: guard.offAllowlistUrl });
    }
  });

  page.on("requestfailed", (req: Request) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const f = { url: sanitizeUrl(req.url()) ?? "", method: req.method(), errorText: req.failure()?.errorText ?? "unknown", at: Date.now() };
      guard.mainFrameFailures.push(f);
      log("main-frame request failed", f);
    }
  });

  // Popups / new tabs are never followed.
  context.on("page", (p) => {
    if (p !== page) {
      log("closing unexpected popup", { url: sanitizeUrl(p.url()) });
      p.close().catch(() => {});
    }
  });
  page.on("dialog", (d) => {
    log("dismissing dialog", { type: d.type(), message: d.message().slice(0, 200) });
    d.dismiss().catch(() => {});
  });

  const release = async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    if (mode === "local") await browser.close().catch(() => {});
    // CDP: do not close the remote browser or its pages — the bot owns the Anchor session (live view handoff, recording).
  };

  return { browser, context, page, guard, mode, release };
}
