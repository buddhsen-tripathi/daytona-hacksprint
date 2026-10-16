/**
 * Provider resolution (ARCHITECTURE.md "Provider resolution"). Lazy singletons.
 *
 * Provider modules are loaded with dynamic imports so a missing/broken module
 * (other agents build them concurrently) degrades to a fallback instead of
 * crashing boot. `providerReport()` says which implementation is active.
 */
import type { BrowserProvider, Classifier, DuplicateService, LocationService, SandboxProvider, Store, Tracer } from "../core/contracts.js";
import { env, filingTarget } from "./env.js";
import {
  type FilingService,
  type StatusService,
  createBasicStatusService,
  createBoundsLocationService,
  createHeuristicClassifier,
  createNoopTracer,
  createUnavailableDuplicateService,
  createUnavailableFilingService,
} from "./fallbacks.js";
import { createMemoryStore } from "./memory-store.js";

export type { FilingService, StatusService } from "./fallbacks.js";

const report: Record<string, string> = {};
export function providerReport(): Record<string, string> {
  return { ...report };
}

type AnyFactory = (...args: unknown[]) => unknown;
/** Import `spec` (relative to this file) and return export `name`, or null. Non-literal specifier ⇒ no compile-time coupling. */
async function loadFactory(spec: string, name: string): Promise<AnyFactory | null> {
  try {
    const mod = (await import(spec)) as Record<string, unknown>;
    const f = mod[name] ?? (mod.default as Record<string, unknown> | undefined)?.[name];
    if (typeof f === "function") return f as AnyFactory;
    console.warn(`[providers] ${spec} has no export ${name}`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)) console.warn(`[providers] failed to load ${spec}: ${msg}`);
  }
  return null;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

const M = {
  surreal: "./surrealdb.js",
  arize: "./arize.js",
  classifier: "../services/classifier.js",
  location: "../services/location.js",
  duplicates: "../services/duplicates.js",
  daytona: "./daytona.js",
  localSandbox: "./local-sandbox.js",
  anchor: "./anchor.js",
  localBrowser: "./local-browser.js",
  filing: "../services/filing.js",
  status: "../services/status.js",
};

export const getStore = once(async (): Promise<Store> => {
  if (env.STORE_BACKEND === "memory") {
    report.store = "memory (STORE_BACKEND=memory)";
    return createMemoryStore();
  }
  const f = await loadFactory(M.surreal, "createSurrealStore");
  if (f) {
    try {
      const store = (await f()) as Store;
      await store.init();
      report.store = `surrealdb (${store.backend})`;
      return store;
    } catch (err) {
      console.warn(`[providers] SurrealDB init failed, using in-memory store: ${(err as Error).message}`);
    }
  }
  report.store = "memory (fallback)";
  return createMemoryStore();
});

export const getTracer = once(async (): Promise<Tracer> => {
  const f = await loadFactory(M.arize, "createTracer");
  if (f) {
    try {
      const t = (await f()) as Tracer;
      report.tracer = `phoenix (${env.PHOENIX_COLLECTOR_ENDPOINT})`;
      return t;
    } catch (err) {
      console.warn(`[providers] tracer init failed: ${(err as Error).message}`);
    }
  }
  report.tracer = "noop";
  return createNoopTracer();
});

export const getClassifier = once(async (): Promise<Classifier> => {
  if (env.OPENROUTER_API_KEY) {
    const f = await loadFactory(M.classifier, "createOpenRouterClassifier");
    if (f) {
      try {
        const c = (await f({ tracer: await getTracer() })) as Classifier;
        report.classifier = `openrouter (${env.OPENROUTER_VISION_MODEL})`;
        return c;
      } catch (err) {
        console.warn(`[providers] classifier init failed: ${(err as Error).message}`);
      }
    }
  }
  report.classifier = "heuristic fallback";
  return createHeuristicClassifier();
});

export const getLocationService = once(async (): Promise<LocationService> => {
  const f = await loadFactory(M.location, "createLocationService");
  if (f) {
    try {
      const s = (await f()) as LocationService;
      report.location = "geosearch";
      return s;
    } catch (err) {
      console.warn(`[providers] location init failed: ${(err as Error).message}`);
    }
  }
  report.location = "bbox fallback (no geocoding)";
  return createBoundsLocationService();
});

export const getDuplicateService = once(async (): Promise<DuplicateService> => {
  const f = await loadFactory(M.duplicates, "createDuplicateService");
  if (f) {
    try {
      const s = (await f()) as DuplicateService;
      report.duplicates = "nyc open data";
      return s;
    } catch (err) {
      console.warn(`[providers] duplicates init failed: ${(err as Error).message}`);
    }
  }
  report.duplicates = "unavailable fallback";
  return createUnavailableDuplicateService();
});

export const getSandboxProvider = once(async (): Promise<SandboxProvider | null> => {
  const choice = env.SANDBOX_PROVIDER || (env.DAYTONA_API_KEY ? "daytona" : "local");
  const order = choice === "daytona" ? ([M.daytona, "createDaytonaSandboxProvider"] as const) : ([M.localSandbox, "createLocalSandboxProvider"] as const);
  const f = await loadFactory(order[0], order[1]);
  if (f) {
    try {
      const p = (await f()) as SandboxProvider;
      report.sandbox = p.name;
      return p;
    } catch (err) {
      console.warn(`[providers] sandbox provider init failed: ${(err as Error).message}`);
    }
  }
  report.sandbox = "unavailable";
  return null;
});

export const getBrowserProvider = once(async (): Promise<BrowserProvider | null> => {
  const choice = env.BROWSER_PROVIDER || (env.ANCHOR_API_KEY ? "anchor" : "local");
  const order = choice === "anchor" ? ([M.anchor, "createAnchorBrowserProvider"] as const) : ([M.localBrowser, "createLocalBrowserProvider"] as const);
  const f = await loadFactory(order[0], order[1]);
  if (f) {
    try {
      const p = (await f()) as BrowserProvider;
      report.browser = p.name;
      return p;
    } catch (err) {
      console.warn(`[providers] browser provider init failed: ${(err as Error).message}`);
    }
  }
  report.browser = "unavailable";
  return null;
});

export const getFilingService = once(async (): Promise<FilingService> => {
  const f = await loadFactory(M.filing, "createFilingService");
  if (f) {
    try {
      const s = (await f({
        store: await getStore(),
        tracer: await getTracer(),
        sandbox: await getSandboxProvider(),
        browser: await getBrowserProvider(),
        target: filingTarget(),
      })) as FilingService;
      report.filing = `filing service (target ${filingTarget()})`;
      return s;
    } catch (err) {
      console.warn(`[providers] filing service init failed: ${(err as Error).message}`);
    }
  }
  report.filing = "unavailable fallback (always FAILED)";
  return createUnavailableFilingService();
});

export const getStatusService = once(async (): Promise<StatusService> => {
  const f = await loadFactory(M.status, "createStatusService");
  if (f) {
    try {
      const s = (await f({ duplicates: await getDuplicateService(), store: await getStore() })) as StatusService;
      report.status = "status service";
      return s;
    } catch (err) {
      console.warn(`[providers] status service init failed: ${(err as Error).message}`);
    }
  }
  report.status = "basic fallback";
  return createBasicStatusService(await getDuplicateService());
});

/** Resolve everything the orchestrator needs. */
export async function resolveProviders() {
  const tracer = await getTracer(); // first: registers the OTel provider
  const store = await getStore();
  await Promise.all([getSandboxProvider(), getBrowserProvider()]);
  const [classifier, location, duplicates, filing, status] = await Promise.all([
    getClassifier(),
    getLocationService(),
    getDuplicateService(),
    getFilingService(),
    getStatusService(),
  ]);
  return { store, tracer, classifier, location, duplicates, filing, status };
}
