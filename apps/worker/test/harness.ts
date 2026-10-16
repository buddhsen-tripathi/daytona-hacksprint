/**
 * Browser test harness: serves test/fixtures/ on 127.0.0.1, opens local Chrome through the worker's own openBrowser
 * (same allowlist guard), and runs an adapter through the same phases as main.ts. No network beyond localhost.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { openBrowser, type BrowserSession } from "../src/browser.js";
import { Recorder } from "../src/evidence.js";
import type { AdapterAction, AdapterContext, ConfirmResult, FormAdapter, WorkerState } from "../src/adapters/types.js";
import { Outcome, type FilingPayload, type WorkerAnswer, type WorkerQuestion, type WorkerStep } from "../src/protocol.js";

export const FIXTURES = resolve(__dirname, "fixtures");

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
/** Browser tests need a local Chrome (playwright-core ships no browser). */
export const HAS_CHROME = !!process.env.CHROME_PATH || [MAC_CHROME, ...LINUX].some((p) => existsSync(p));

export async function serveFixtures(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = resolve(FIXTURES, `.${path}`);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": extname(file) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export interface RunResult {
  outcome: { status: string; errorCode: string | null; message: string; data?: Record<string, unknown> } | { status: "CONFIRMED"; confirm: ConfirmResult };
  actions: AdapterAction[];
  questions: WorkerQuestion[];
  events: Recorder["events"];
  submitClicked: boolean;
  /** ctx.state.formSchema at the end of the run (what main.ts copies into WorkerResult.formSchema). */
  formSchema: WorkerState["formSchema"];
  session: BrowserSession;
}

/**
 * Run navigate → inspect → fill → validate → submit → confirm like main.ts. `answers` (by question id) simulate the
 * resident; without one, ctx.ask throws the fallback (questions disabled). The caller releases `session`.
 */
export async function runAdapter(adapter: FormAdapter, payload: FilingPayload, answers: Record<string, WorkerAnswer> = {}): Promise<RunResult> {
  const rec = new Recorder(mkdtempSync(join(tmpdir(), "relay-worker-test-")));
  const session = await openBrowser(payload, () => {});
  const state: WorkerState = { submitClicked: false, finalUrl: null, formSchema: null };
  const actions: AdapterAction[] = [];
  const questions: WorkerQuestion[] = [];
  let current: WorkerStep = "navigate";
  const ctx: AdapterContext = {
    page: session.page,
    payload,
    guard: session.guard,
    state,
    log: (step, level, message, data) => rec.log(step, level, message, data),
    shot: (step, name, summary) => rec.shot(session.page, step, name, summary),
    saveHtml: (step, name, summary) => rec.saveHtml(session.page, step, name, summary),
    checkGuard: (step) => {
      if (session.guard.offAllowlist) throw new Outcome("HUMAN_ACTION_REQUIRED", "OFF_ALLOWLIST_NAVIGATION", `off allowlist during ${step}`);
    },
    ask: async (q, fallback) => {
      questions.push(q);
      const a = answers[q.id];
      if (!a) throw fallback;
      return a;
    },
    action: (a) => {
      actions.push(a);
      rec.log(current, "info", "action", { action: a });
    },
  };
  const step = async <T>(name: WorkerStep, fn: () => Promise<T>) => {
    current = name;
    const out = await fn();
    ctx.checkGuard(name);
    return out;
  };
  let outcome: RunResult["outcome"];
  try {
    await step("navigate", () => adapter.navigate(ctx));
    await step("inspect", () => adapter.inspect(ctx));
    await step("fill", () => adapter.fill(ctx));
    const v = await step("validate", () => adapter.validate(ctx));
    if (!v.ok) throw new Outcome("FAILED", "BROWSER_ERROR", `validate: ${v.problems.join("; ")}`, { problems: v.problems });
    await step("submit", () => adapter.submit(ctx));
    outcome = { status: "CONFIRMED", confirm: await step("confirm", () => adapter.confirm(ctx)) };
  } catch (err) {
    if (!(err instanceof Outcome)) throw err;
    outcome = { status: err.status, errorCode: err.errorCode, message: err.message, data: err.data };
  }
  return { outcome, actions, questions, events: rec.events, submitClicked: state.submitClicked, formSchema: state.formSchema, session };
}
