/**
 * Crawl the NYC311 "Report Problems" directory into a category catalog (#7).
 *
 *   pnpm --filter @311relay/bot exec tsx scripts/crawl-311-catalog.ts [--limit 20] [--delay 600] [--refresh] [--no-probe] [--headed] [--no-db] [--embedded]
 *
 * 1. /report-problems/: the "All A–Z" list (every article) and the "All by category" tree.
 * 2. Each subcategory page: topic + one-line summary per article.
 * 3. Each article: accordion cards → SR actions (a.contentaction), outbound links, phone, agency.
 * 4. One GET per article's official link (deduped) to detect CAPTCHA / sign-in. Never clicks an
 *    SR button: for most agencies that is a postback that creates a draft on the City's side.
 *
 * Local Chrome via playwright-core (CHROME_PATH, else the same paths the worker uses). One page,
 * sequential, `--delay` ms between loads, images/fonts/media blocked. Everything is cached under
 * .runs/catalog-cache/ and reused, so an interrupted run resumes; --refresh ignores the cache.
 * Outputs: fixtures/nyc311-catalog.json (committed snapshot, sorted by id; only on a full run, never with
 * --limit) and complaint_category rows in SurrealDB (UPSERT … MERGE by id; --no-db skips, --embedded uses
 * mem://). The CATEGORIES entries (subway-delay) are added with their worker adapter as `automation`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { CatalogEntry } from "../src/core/contracts.js";
import { REPO_ROOT, RUNS_DIR } from "../src/integrations/env.js";
import { createSurrealStore } from "../src/integrations/surrealdb.js";
import {
  assignUniqueIds,
  buildCatalogEntry,
  fileableCatalogEntries,
  PORTAL,
  probeTarget,
  type LandingProbe,
  type RawArticle,
  type RawCard,
} from "../src/services/catalog-crawl.js";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => argv.includes(name);
const opt = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const LIMIT = opt("--limit", Infinity);
const DELAY_MS = opt("--delay", 600);
const REFRESH = flag("--refresh");
const PROBE = !flag("--no-probe");
const HEADED = flag("--headed");
const DB = !flag("--no-db");
const EMBEDDED = flag("--embedded");
const SNAPSHOT = resolve(REPO_ROOT, "fixtures/nyc311-catalog.json");

const CACHE = resolve(RUNS_DIR, "catalog-cache");
for (const d of ["", "categories", "articles"]) mkdirSync(resolve(CACHE, d), { recursive: true });

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

type IndexArticle = { kaNumber: string; title: string; summary: string | null };
type IndexGroup = { group: string; subcategories: { name: string; url: string }[]; articles: IndexArticle[] };
type Index = { az: IndexArticle[]; groups: IndexGroup[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readCache = <T>(rel: string): T | null => {
  const p = resolve(CACHE, rel);
  return !REFRESH && existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
};
const writeCache = (rel: string, v: unknown) => writeFileSync(resolve(CACHE, rel), `${JSON.stringify(v, null, 2)}\n`);
const kaFrom = (href: string | null) => href?.match(/kanumber=(KA-\d+)/i)?.[1].toUpperCase() ?? null;

let lastLoad = 0;
async function load(page: Page, url: string, waitUntil: "domcontentloaded" | "networkidle" = "domcontentloaded") {
  const wait = lastLoad + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastLoad = Date.now();
  await page.goto(url, { waitUntil, timeout: 45_000 });
}

// -- 1. index -----------------------------------------------------------------
async function crawlIndex(page: Page): Promise<Index> {
  const cached = readCache<Index>("index.json");
  if (cached) return cached;
  await load(page, `${PORTAL}/report-problems/`, "networkidle");
  // No named helpers inside evaluate(): tsx's keepNames would inject a __name() the page doesn't have.
  const raw = await page.evaluate(() => ({
    az: Array.from(document.querySelectorAll<HTMLAnchorElement>("#pills-all-az a[href*='kanumber']")).map((a) => ({
      href: a.getAttribute("href"),
      title: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
    groups: Array.from(document.querySelectorAll("#pills-all-by-category .accordion > .card")).map((card) => {
      const sections = Array.from(card.querySelectorAll(".panel-expand"));
      return {
        group: (card.querySelector(".card-header")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        subcategories: sections
          .map((s) => s.querySelector<HTMLAnchorElement>("a.kacategory"))
          .filter((a): a is HTMLAnchorElement => !!a)
          .map((a) => ({ name: (a.textContent ?? "").replace(/\s+/g, " ").trim(), url: a.href })),
        articles: sections
          .map((s) => ({ a: s.querySelector<HTMLAnchorElement>("a[href*='kanumber']"), p: s.querySelector("p") }))
          .filter((x) => !!x.a)
          .map((x) => ({
            href: x.a!.getAttribute("href"),
            title: (x.a!.textContent ?? "").replace(/\s+/g, " ").trim(),
            summary: (x.p?.textContent ?? "").replace(/\s+/g, " ").trim() || null,
          })),
      };
    }),
  }));
  const index: Index = {
    az: raw.az.flatMap((a) => (kaFrom(a.href) ? [{ kaNumber: kaFrom(a.href)!, title: a.title, summary: null }] : [])),
    groups: raw.groups.map((g) => ({
      group: g.group,
      subcategories: g.subcategories,
      articles: g.articles.flatMap((a) => (kaFrom(a.href) ? [{ kaNumber: kaFrom(a.href)!, title: a.title, summary: a.summary }] : [])),
    })),
  };
  writeCache("index.json", index);
  return index;
}

// -- 2. topics + summaries ------------------------------------------------------
async function crawlTopics(page: Page, index: Index) {
  const topic = new Map<string, string>();
  const summary = new Map<string, string>();
  const note = (ka: string, t: string, s: string | null) => {
    if (!topic.has(ka)) topic.set(ka, t);
    if (s && !summary.has(ka)) summary.set(ka, s);
  };
  for (const g of index.groups) {
    for (const a of g.articles) note(a.kaNumber, g.group, a.summary);
    for (const sub of g.subcategories) {
      const id = new URL(sub.url).searchParams.get("id") ?? sub.name;
      let list = readCache<IndexArticle[]>(`categories/${id}.json`);
      if (!list) {
        await load(page, sub.url);
        list = (
          await page.$$eval("#categories-container li", (lis) =>
            lis.map((li) => ({
              href: li.querySelector("a")?.getAttribute("href") ?? null,
              title: (li.querySelector("a")?.textContent ?? "").replace(/\s+/g, " ").trim(),
              summary: (li.querySelector("p.description")?.textContent ?? "").replace(/\s+/g, " ").trim() || null,
            })),
          )
        ).flatMap((a) => (kaFrom(a.href) ? [{ kaNumber: kaFrom(a.href)!, title: a.title, summary: a.summary }] : []));
        writeCache(`categories/${id}.json`, list);
      }
      for (const a of list) note(a.kaNumber, `${g.group} › ${sub.name}`, a.summary);
    }
  }
  return { topic, summary };
}

// -- 3. articles ----------------------------------------------------------------
async function crawlArticle(page: Page, kaNumber: string): Promise<RawArticle> {
  const cached = readCache<RawArticle>(`articles/${kaNumber}.json`);
  if (cached) return cached;
  await load(page, `${PORTAL}/article/?kanumber=${kaNumber}`);
  await page.waitForSelector(".ka-content", { timeout: 15_000 }).catch(() => {});
  const extracted = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".ka-content .accordion > .card")).map((c) => {
      const header = c.querySelector(".card-header");
      const body = c.querySelector(".collapse") ?? c;
      const clone = body.cloneNode(true) as HTMLElement;
      // Drop the red "Call 911" banner and the "Need something else?" cross-links box from the text.
      clone.querySelectorAll(".divTable, style, script").forEach((e) => e.remove());
      Array.from(clone.querySelectorAll("div"))
        .filter((d) => d.firstElementChild?.tagName === "P" && /Need something else\?/.test(d.firstElementChild.textContent ?? ""))
        .forEach((d) => d.remove());
      return {
        title: header ? (header.textContent ?? "").replace(/\s+/g, " ").trim() : null,
        text: (clone.innerText || clone.textContent || "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim(),
        links: Array.from(body.querySelectorAll("a")).map((a) => ({
          cls: a.className || "",
          text: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
          href: a.getAttribute("href"),
          onclick: a.getAttribute("onclick"),
        })),
      };
    });
    return { title: document.title.replace(/\s*·\s*NYC311\s*$/, "").trim(), cards };
  });
  const raw: RawArticle = { kaNumber, title: extracted.title, cards: extracted.cards as RawCard[] };
  writeCache(`articles/${kaNumber}.json`, raw);
  return raw;
}

// -- 4. one-hop probes ------------------------------------------------------------
async function probe(page: Page, url: string): Promise<LandingProbe | null> {
  try {
    await load(page, url);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const finalUrl = page.url();
    const found = await page.evaluate(() => ({
      captcha:
        document.querySelectorAll("[data-sitekey], .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare']").length > 0,
      password: Array.from(document.querySelectorAll<HTMLInputElement>("input[type=password]")).some((i) => i.offsetParent !== null),
    }));
    return { finalUrl, hasCaptcha: found.captcha, requiresLogin: found.password || /sign-?in|log-?in|\/auth|\/sso|b2clogin/i.test(finalUrl) };
  } catch (err) {
    console.warn(`  probe failed ${url}: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

// -- main -----------------------------------------------------------------------------
const executablePath = process.env.CHROME_PATH || [MAC_CHROME, ...LINUX_CANDIDATES].find((p) => existsSync(p));
const browser = await chromium.launch({ headless: !HEADED, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ userAgent: "311Relay catalog crawler (hackathon project; polite, cached)" });
await context.route("**/*", (route) => (["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue()));
const page = await context.newPage();

try {
  const t0 = Date.now();
  const index = await crawlIndex(page);
  console.log(`index: ${index.az.length} articles A–Z, ${index.groups.length} groups, ${index.groups.reduce((n, g) => n + g.subcategories.length, 0)} subcategories`);

  const { topic, summary } = await crawlTopics(page, index);
  console.log(`topics: ${topic.size} articles placed in the category tree`);

  const articles = index.az.slice(0, LIMIT);
  const raws: RawArticle[] = [];
  for (const [i, a] of articles.entries()) {
    raws.push(await crawlArticle(page, a.kaNumber));
    if ((i + 1) % 50 === 0 || i + 1 === articles.length) console.log(`articles: ${i + 1}/${articles.length}`);
  }

  const probes = readCache<Record<string, LandingProbe | null>>("probes.json") ?? {};
  if (PROBE) {
    const targets = [...new Set(raws.map(probeTarget).filter((u): u is string => !!u))].filter((u) => !(u in probes));
    for (const [i, url] of targets.entries()) {
      probes[url] = await probe(page, url);
      if ((i + 1) % 25 === 0 || i + 1 === targets.length) {
        writeCache("probes.json", probes);
        console.log(`probes: ${i + 1}/${targets.length}`);
      }
    }
  }

  const now = new Date().toISOString();
  const crawled = assignUniqueIds(
    raws.map((raw) => {
      const target = probeTarget(raw);
      return buildCatalogEntry(raw, { topic: topic.get(raw.kaNumber) ?? null, summary: summary.get(raw.kaNumber) ?? null, probe: target ? (probes[target] ?? null) : null, now });
    }),
  );
  const fileable = fileableCatalogEntries(now);
  const taken = new Set(fileable.map((e) => e.id));
  const entries: CatalogEntry[] = [...fileable, ...crawled.filter((e) => !taken.has(e.id))].sort((a, b) => a.id.localeCompare(b.id));

  writeCache("catalog.draft.json", entries);
  if (LIMIT === Infinity) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`snapshot: ${entries.length} entries → ${SNAPSHOT}`);
  } else console.log("snapshot: skipped (--limit run)");

  if (DB) {
    const store = createSurrealStore(EMBEDDED ? { url: "mem://" } : {});
    try {
      await store.init();
      const n = await store.upsertCatalog(entries);
      console.log(`surrealdb: upserted ${n} complaint_category rows (${store.backend} ${store.namespace}/${store.database})`);
    } finally {
      await store.close();
    }
  }
  const byChannel = entries.reduce<Record<string, number>>((m, e) => ((m[e.channel] = (m[e.channel] ?? 0) + 1), m), {});
  console.log(`catalog: ${entries.length} entries ${JSON.stringify(byChannel)} in ${Math.round((Date.now() - t0) / 1000)} s → ${resolve(CACHE, "catalog.draft.json")}`);
} finally {
  await browser.close();
}
