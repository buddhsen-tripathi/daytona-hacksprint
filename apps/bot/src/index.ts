/**
 * 311Relay boot: env → providers → orchestrator → Telegram (optional) → API.
 * Works without TELEGRAM_BOT_TOKEN (API + scripted event endpoint still run).
 */
import type { Bot } from "grammy";
import type { Transport } from "./core/contracts.js";
import { createOrchestrator } from "./core/orchestrator.js";
import { startApiServer } from "./api/server.js";
import { env, hasTelegram, webhookMode } from "./integrations/env.js";
import { getTracer, providerReport, resolveProviders } from "./integrations/index.js";
import { type WebhookHandler, createBot, startBot, wireBot } from "./telegram/bot.js";

const nullTransport: Transport = {
  async send(m) {
    console.log(`[no-telegram] → ${m.chatId}: ${m.text.slice(0, 120).replace(/\n/g, " ")}`);
    return { messageId: null };
  },
  async downloadFile() {
    throw new Error("Telegram not configured");
  },
};

async function main() {
  await getTracer(); // registers the OTel provider before anything else touches the context API
  const providers = await resolveProviders();
  let bot: Bot | null = null;
  let transport: Transport = nullTransport;
  if (hasTelegram()) {
    const created = createBot();
    bot = created.bot;
    transport = created.transport;
  }
  const orchestrator = createOrchestrator({ ...providers, transport });

  let webhook: WebhookHandler | null = null;
  const server = await startApiServer({ store: providers.store, tracer: providers.tracer, memory: providers.memory, orchestrator, getWebhook: () => webhook });

  let telegramLine = "off (TELEGRAM_BOT_TOKEN not set)";
  if (bot) {
    wireBot(bot, orchestrator);
    try {
      const started = await startBot(bot);
      webhook = started.webhook;
      telegramLine = `@${started.username} via ${started.mode}${webhookMode() ? ` (${env.PUBLIC_WEBHOOK_URL}/telegram/webhook)` : ""}`;
    } catch (err) {
      telegramLine = `FAILED to start: ${(err as Error).message}`;
    }
  }

  const p = providerReport();
  const banner = [
    "",
    "  311Relay bot",
    "  ─────────────────────────────────────────",
    `  telegram   ${telegramLine}`,
    `  api        http://localhost:${env.PORT_API}/api/health`,
    `  store      ${p.store ?? providers.store.backend}`,
    `  memory     ${p.memory ?? "?"}`,
    `  tracer     ${p.tracer ?? "?"}  (project ${env.PHOENIX_PROJECT})`,
    `  classifier ${p.classifier ?? "?"}`,
    `  location   ${p.location ?? "?"}`,
    `  duplicates ${p.duplicates ?? "?"}`,
    `  sandbox    ${p.sandbox ?? "?"}`,
    `  browser    ${p.browser ?? "?"}`,
    `  filing     ${p.filing ?? "?"}  (official forms; ALLOW_REAL_SUBMIT=${env.ALLOW_REAL_SUBMIT === "1" ? "1" : "off"})`,
    `  status     ${p.status ?? "?"}`,
    "",
  ].join("\n");
  console.log(banner);

  const shutdown = async (sig: string) => {
    console.log(`\n[311relay] ${sig} received, shutting down…`);
    await bot?.stop().catch(() => {});
    server.close();
    await providers.tracer.flush().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[311relay] fatal boot error:", err);
  process.exit(1);
});
