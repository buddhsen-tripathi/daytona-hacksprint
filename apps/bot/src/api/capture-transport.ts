/**
 * In-process Transport that records outbound messages. Used by
 * POST /api/event and the scripted runner (scripts/). File ids of the form
 * "fixture:<name>" resolve to fixtures/images/<name>.jpg (or .png/.jpeg);
 * "path:<abs path>" copies a local file. photoPath / videoPath are recorded as-is
 * (the scripted runner prints them).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { OutboundMessage, Transport } from "../core/contracts.js";
import { REPO_ROOT } from "../integrations/env.js";

export const FIXTURE_IMAGES = resolve(REPO_ROOT, "fixtures/images");

export function resolveFixture(fileId: string): string | null {
  if (fileId.startsWith("fixture:")) {
    const name = fileId.slice("fixture:".length).replace(/[^a-zA-Z0-9_.-]/g, "");
    for (const ext of ["", ".jpg", ".jpeg", ".png", ".webp"]) {
      const p = resolve(FIXTURE_IMAGES, name + ext);
      if (existsSync(p) && extname(p)) return p;
    }
    return null;
  }
  if (fileId.startsWith("path:")) {
    const p = resolve(fileId.slice(5));
    return existsSync(p) ? p : null;
  }
  return null;
}

export type CapturedMessage = OutboundMessage & { messageId: number; at: string };

/** A live worker question seen in captured messages; answer by POSTing a callback with `options[i].data` (or a text event). */
export type CapturedQuestion = { complaintId: string; questionId: string; prompt: string; options: { text: string; data: string }[]; messageId: number };

/** Extract `answer_q:<complaintId>:<v>:<qid>:<i>` questions from captured messages (newest last). */
export function capturedQuestions(messages: CapturedMessage[]): CapturedQuestion[] {
  const out: CapturedQuestion[] = [];
  for (const m of messages) {
    const opts = (m.buttons ?? []).flat().filter((b): b is { text: string; data: string } => typeof b.data === "string" && b.data.startsWith("answer_q:"));
    const isTextQuestion = !opts.length && /needs one answer from you/i.test(m.text);
    if (!opts.length && !isTextQuestion) continue;
    const [, complaintId = "", , questionId = ""] = opts[0]?.data.split(":") ?? [];
    out.push({ complaintId, questionId, prompt: m.text.replace(/<[^>]+>/g, ""), options: opts.map((b) => ({ text: b.text, data: b.data })), messageId: m.messageId });
  }
  return out;
}

export function createCaptureTransport(opts: { onSend?: (m: CapturedMessage) => void; onQuestion?: (q: CapturedQuestion) => void } = {}) {
  const messages: CapturedMessage[] = [];
  let nextId = 1;
  const transport: Transport & { messages: CapturedMessage[] } = {
    messages,
    async send(msg) {
      const messageId = msg.editMessageId ?? nextId++;
      const captured: CapturedMessage = { ...msg, messageId, at: new Date().toISOString() };
      messages.push(captured);
      opts.onSend?.(captured);
      if (opts.onQuestion) for (const q of capturedQuestions([captured])) opts.onQuestion(q);
      return { messageId };
    },
    async downloadFile(fileId, destDir) {
      const src = resolveFixture(fileId);
      if (!src) throw new Error(`unknown fixture/file id`);
      mkdirSync(destDir, { recursive: true });
      const dest = resolve(destDir, `${Date.now().toString(36)}-${basename(src)}`);
      copyFileSync(src, dest);
      const ext = extname(src).toLowerCase();
      return { path: dest, mime: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg" };
    },
    async ackCallback() {},
    async typing() {},
  };
  return transport;
}
