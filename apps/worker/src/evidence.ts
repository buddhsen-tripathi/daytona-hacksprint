import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { nowIso, sanitizeUrl, type EvidenceFile, type WorkerEvent, type WorkerStep } from "./protocol.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";

/** Collects events + evidence files in outDir. Evidence failures are logged, never fatal. */
export class Recorder {
  readonly events: WorkerEvent[] = [];
  readonly evidence: EvidenceFile[] = [];
  private seq = 0;
  private readonly logPath: string;

  constructor(readonly outDir: string, private readonly evidenceTimeoutMs = 15000) {
    mkdirSync(outDir, { recursive: true });
    this.logPath = join(outDir, "worker.log");
    writeFileSync(this.logPath, "");
    this.evidence.push({ name: "worker.log", type: "log", step: "navigate", summary: "Worker event log (one JSON event per line)" });
  }

  log(step: WorkerStep, level: WorkerEvent["level"], message: string, data?: Record<string, unknown>): WorkerEvent {
    const e: WorkerEvent = { ts: nowIso(), step, level, message, ...(data ? { data } : {}) };
    this.events.push(e);
    const line = JSON.stringify(e);
    process.stdout.write(`EVT ${line}\n`);
    try {
      appendFileSync(this.logPath, line + "\n");
    } catch {
      /* ignore */
    }
    return e;
  }

  private nextName(step: WorkerStep, name: string, ext: string) {
    this.seq += 1;
    return `${String(this.seq).padStart(2, "0")}-${step}-${slug(name)}.${ext}`;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`evidence timeout ${this.evidenceTimeoutMs}ms`)), this.evidenceTimeoutMs))]);
  }

  /** Full-page screenshot → `<NN>-<step>-<name>.png`. */
  async shot(page: Page, step: WorkerStep, name: string, summary?: string): Promise<EvidenceFile | null> {
    const file = this.nextName(step, name, "png");
    try {
      await this.withTimeout(page.screenshot({ path: join(this.outDir, file), fullPage: true, timeout: this.evidenceTimeoutMs }));
      const ev: EvidenceFile = { name: file, type: "screenshot", step, summary: summary ?? `${step}: ${name} (${sanitizeUrl(page.url()) ?? "?"})` };
      this.evidence.push(ev);
      this.log(step, "info", `screenshot ${file}`, { evidence: file });
      return ev;
    } catch (err) {
      this.log(step, "warn", `screenshot failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      return null;
    }
  }

  /** Saves the page HTML (e.g. the confirmation page) for the verifier. */
  async saveHtml(page: Page, step: WorkerStep, name: string, summary?: string): Promise<EvidenceFile | null> {
    const file = this.nextName(step, name, "html");
    try {
      const html = await this.withTimeout(page.content());
      writeFileSync(join(this.outDir, file), html);
      const ev: EvidenceFile = { name: file, type: "html", step, summary: summary ?? `${step}: ${name} HTML` };
      this.evidence.push(ev);
      this.log(step, "info", `saved html ${file}`, { evidence: file });
      return ev;
    } catch (err) {
      this.log(step, "warn", `html capture failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      return null;
    }
  }
}
