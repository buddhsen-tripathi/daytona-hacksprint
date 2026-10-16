/**
 * grammY wiring: Telegram updates → InboundEvent → orchestrator.
 * Long polling by default; webhook (secret-token verified) when
 * PUBLIC_WEBHOOK_URL + TELEGRAM_WEBHOOK_SECRET are set.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Bot, GrammyError, HttpError, webhookCallback } from "grammy";
import type { InboundEvent, Transport } from "../core/contracts.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { env, webhookMode } from "../integrations/env.js";
import { BOT_COMMANDS, registerCommandHandlers } from "./handlers/commands.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";
import { registerMessageHandlers } from "./handlers/messages.js";
import { createTelegramTransport } from "./transport.js";

export type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Create the bot + transport (before the orchestrator exists, so the orchestrator can use the transport). */
export function createBot(token = env.TELEGRAM_BOT_TOKEN): { bot: Bot; transport: Transport } {
  const bot = new Bot(token);
  return { bot, transport: createTelegramTransport(bot.api, token) };
}

export function wireBot(bot: Bot, orchestrator: Orchestrator) {
  // Fire-and-forget: the orchestrator serializes per chat; other chats aren't blocked; webhooks return fast.
  const dispatch = (e: InboundEvent) => {
    void orchestrator.handle(e).catch((err) => console.error("[telegram] dispatch failed:", err));
  };
  registerCommandHandlers(bot, dispatch);
  registerCallbackHandlers(bot, dispatch);
  registerMessageHandlers(bot, dispatch);

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) console.error(`[telegram] API error in update ${err.ctx.update.update_id}: ${e.description}`);
    else if (e instanceof HttpError) console.error("[telegram] network error:", e.message);
    else console.error("[telegram] handler error:", e);
  });
}

/** Starts polling or registers the webhook. Returns the webhook handler for the API server when in webhook mode. */
export async function startBot(bot: Bot): Promise<{ mode: "polling" | "webhook"; username: string; webhook: WebhookHandler | null }> {
  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS).catch((e) => console.warn("[telegram] setMyCommands failed:", e.message));
  const username = bot.botInfo.username;
  if (webhookMode()) {
    const url = `${env.PUBLIC_WEBHOOK_URL.replace(/\/$/, "")}/telegram/webhook`;
    await bot.api.setWebhook(url, { secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
    const webhook = webhookCallback(bot, "http", { secretToken: env.TELEGRAM_WEBHOOK_SECRET }) as WebhookHandler;
    return { mode: "webhook", username, webhook };
  }
  await bot.api.deleteWebhook().catch(() => {});
  // grammY stops polling for good on a 409 (another getUpdates consumer). After a restart,
  // Telegram can still hold the previous instance's 30 s long poll, so retry with backoff
  // instead of dying. A persistent 409 means a second instance really is running elsewhere.
  const poll = async (attempt = 1): Promise<void> => {
    try {
      await bot.start({
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
        onStart: () => console.log(`[telegram] polling as @${username}${attempt > 1 ? ` (attempt ${attempt})` : ""}`),
      });
    } catch (err) {
      const is409 = typeof err === "object" && err !== null && (err as { error_code?: number }).error_code === 409;
      if (is409 && attempt < 10) {
        // Fully stop grammY's internal loop before starting again, otherwise two loops in this
        // process fight each other forever. Wait long enough for a killed predecessor's 30 s
        // long poll to expire on Telegram's side.
        await bot.stop().catch(() => {});
        const waitMs = 35_000;
        console.warn(`[telegram] 409 conflict (another getUpdates consumer); retrying in ${waitMs / 1000}s`);
        await new Promise((r) => setTimeout(r, waitMs));
        return poll(attempt + 1);
      }
      console.error("[telegram] polling stopped:", err);
    }
  };
  void poll();
  return { mode: "polling", username, webhook: null };
}
