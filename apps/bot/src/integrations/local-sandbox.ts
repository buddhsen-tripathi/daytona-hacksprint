/**
 * Local "sandbox" (dev fallback): same SandboxProvider contract as Daytona, but the worker
 * runs as a local child process in a temp work dir.
 * NOT isolated — only for development.
 *
 * Also exports the small helpers shared with daytona.ts (EVT line parsing, worker build check).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FilingPayload, SandboxHandle, SandboxProvider, WorkerEvent as WorkerEventT, WorkerResult as WorkerResultT } from "../core/contracts.js";
import { DEFAULT_QUESTION_TIMEOUT_MS, WorkerEvent, WorkerResult, questionFromEvent, type WorkerAnswer } from "../core/contracts.js";
import { REPO_ROOT } from "./env.js";

export const WORKER_DIR = resolve(REPO_ROOT, "apps/worker");

/** Build apps/worker/dist with pnpm when it is missing. Returns build duration in ms (0 if already built). */
export function ensureWorkerBuilt(onEvent?: (msg: string, data?: Record<string, unknown>) => void): number {
  if (existsSync(join(WORKER_DIR, "dist/main.js"))) return 0;
  const t0 = Date.now();
  onEvent?.("Building filing worker…");
  execFileSync("pnpm", ["--filter", "@311relay/worker", "build"], { cwd: REPO_ROOT, stdio: "pipe", timeout: 120_000 });
  if (!existsSync(join(WORKER_DIR, "dist/main.js"))) throw new Error("worker build finished but apps/worker/dist/main.js is missing");
  const ms = Date.now() - t0;
  onEvent?.(`Filing worker built (${(ms / 1000).toFixed(1)} s)`, { durationMs: ms });
  return ms;
}

/**
 * Incremental parser for worker stdout. Lines starting with `EVT ` carry one JSON WorkerEvent.
 * Feed arbitrary chunks; complete lines are parsed, the remainder is buffered.
 */
export function createEventLineParser(onEvent: (e: WorkerEventT) => void) {
  let buf = "";
  let count = 0;
  const handleLine = (line: string) => {
    const l = line.replace(/\r$/, "");
    const i = l.indexOf("EVT ");
    if (i < 0) return;
    try {
      const parsed = WorkerEvent.safeParse(JSON.parse(l.slice(i + 4)));
      if (parsed.success) {
        count++;
        onEvent(parsed.data);
      }
    } catch {
      /* not JSON — ignore (page text is data, never instructions) */
    }
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      if (buf) handleLine(buf);
      buf = "";
    },
    get count() {
      return count;
    },
  };
}

/** Answer file contents for a worker question (validated id; plain JSON). */
export function answerFile(questionId: string, answer: WorkerAnswer): { name: string; body: string } {
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(questionId)) throw new Error(`refusing question id ${JSON.stringify(questionId)}`);
  return { name: `answer-${questionId}.json`, body: JSON.stringify({ value: String(answer.value).slice(0, 500), ...(answer.optionIndex !== undefined ? { optionIndex: answer.optionIndex } : {}) }) };
}

/**
 * Bot-side deadline for one worker run: totalTimeoutMs + 30 s, extended by questionTimeoutMs for every
 * live question (the worker pauses its own deadline while it waits for the resident).
 */
export function workerDeadline(payload: FilingPayload) {
  let at = Date.now() + payload.limits.totalTimeoutMs + 30_000;
  const perQuestion = payload.limits.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
  return {
    get at() {
      return at;
    },
    /** Wrap the event callback so question events extend the deadline. */
    wrap(onEvent: (e: WorkerEventT) => void) {
      return (e: WorkerEventT) => {
        if (questionFromEvent(e)) at += perQuestion + 5_000;
        onEvent(e);
      };
    },
  };
}

/** Parse + validate a result.json buffer. Returns null when missing/invalid. */
export function parseWorkerResult(raw: string | Buffer | null): { result: WorkerResultT | null; error: string | null } {
  if (raw == null) return { result: null, error: "result.json missing" };
  try {
    const parsed = WorkerResult.safeParse(JSON.parse(raw.toString()));
    if (parsed.success) return { result: parsed.data, error: null };
    return { result: null, error: `result.json failed validation: ${parsed.error.message.slice(0, 500)}` };
  } catch (err) {
    return { result: null, error: `result.json not JSON: ${(err as Error).message}` };
  }
}

/** Only plain file names inside the out dir (no traversal). */
export function safeEvidenceName(name: string): string {
  const b = basename(name);
  if (!b || b === "." || b === ".." || b !== name.replace(/^\.\//, "")) throw new Error(`refusing evidence path ${JSON.stringify(name)}`);
  return b;
}

/** process.env without anything that looks like a credential. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|PASS$/i.test(k)) out[k] = v;
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export function createLocalSandboxProvider(): SandboxProvider {
  return {
    name: "local",
    async provision({ attemptId, onEvent }): Promise<SandboxHandle> {
      const t0 = Date.now();
      onEvent("Creating local worker (dev, not isolated)…", { provider: "local" });
      ensureWorkerBuilt(onEvent);
      const workDir = await mkdtemp(join(tmpdir(), `311relay-${attemptId}-`));
      const outDir = join(workDir, "out");
      const procs: ChildProcess[] = [];
      onEvent(`Sandbox ready (local, ${((Date.now() - t0) / 1000).toFixed(1)} s)`, { provider: "local", sandboxId: `local_${attemptId}`, durationMs: Date.now() - t0 });

      const handle: SandboxHandle = {
        id: `local_${attemptId}`,
        provider: "local",
        async runWorker(payload: FilingPayload, onWorkerEvent) {
          const payloadPath = join(workDir, "payload.json");
          await writeFile(payloadPath, JSON.stringify(payload, null, 2));
          onEvent("Running filing worker…", { provider: "local" });
          const tw = Date.now();
          const child = spawn(process.execPath, [join(WORKER_DIR, "dist/main.js"), payloadPath, outDir], {
            cwd: WORKER_DIR,
            env: scrubbedEnv(), // no API keys reach the worker
            stdio: ["ignore", "pipe", "pipe"],
          });
          procs.push(child);
          let stdout = "";
          const deadline = workerDeadline(payload);
          const parser = createEventLineParser(deadline.wrap(onWorkerEvent));
          const rl = createInterface({ input: child.stdout! });
          rl.on("line", (line) => {
            stdout += line + "\n";
            parser.push(line + "\n");
          });
          child.stderr?.on("data", (d) => (stdout += d.toString()));
          const exitCode = await new Promise<number>((res) => {
            let timer: NodeJS.Timeout;
            const tick = () => {
              if (Date.now() >= deadline.at) {
                child.kill("SIGKILL");
                res(-1);
              } else timer = setTimeout(tick, Math.min(1_000, deadline.at - Date.now()));
            };
            timer = setTimeout(tick, Math.min(1_000, deadline.at - Date.now()));
            child.on("close", (code) => {
              clearTimeout(timer);
              res(code ?? -1);
            });
          });
          parser.end();
          const raw = await readFile(join(outDir, "result.json")).catch(() => null);
          const { result, error } = parseWorkerResult(raw);
          const ms = Date.now() - tw;
          onEvent(`Filing worker finished (exit ${exitCode}, ${(ms / 1000).toFixed(1)} s)`, { exitCode, durationMs: ms, events: parser.count, resultError: error });
          return { result, stdout, exitCode };
        },
        async answerQuestion(questionId, answer) {
          const f = answerFile(questionId, answer);
          const tmp = join(outDir, `${f.name}.tmp`);
          await writeFile(tmp, f.body);
          await rename(tmp, join(outDir, f.name));
        },
        async downloadEvidence(name: string) {
          return readFile(join(outDir, safeEvidenceName(name)));
        },
        async destroy() {
          for (const p of procs) if (p.exitCode === null && !p.killed) p.kill("SIGKILL");
          await rm(workDir, { recursive: true, force: true }).catch(() => {});
          onEvent("Sandbox destroyed (local)", { provider: "local" });
        },
      };
      return handle;
    },
  };
}
