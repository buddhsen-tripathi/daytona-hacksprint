/**
 * In-process Transport that records outbound messages. Used by
 * POST /api/demo/event and scripts/demo.ts. File ids of the form
 * "fixture:<name>" resolve to fixtures/images/<name>.jpg (or .png/.jpeg);
 * "path:<abs path>" copies a local file.
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

export function createCaptureTransport(opts: { onSend?: (m: CapturedMessage) => void } = {}) {
  const messages: CapturedMessage[] = [];
  let nextId = 1;
  const transport: Transport & { messages: CapturedMessage[] } = {
    messages,
    async send(msg) {
      const messageId = msg.editMessageId ?? nextId++;
      const captured: CapturedMessage = { ...msg, messageId, at: new Date().toISOString() };
      messages.push(captured);
      opts.onSend?.(captured);
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
