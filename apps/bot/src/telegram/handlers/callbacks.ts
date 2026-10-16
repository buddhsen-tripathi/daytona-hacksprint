import type { Bot } from "grammy";
import type { InboundEvent } from "../../core/contracts.js";
import { decodeCallback } from "../../core/contracts.js";

/** Actions whose buttons are single-use: strip the keyboard from the tapped message to prevent double taps. */
const SINGLE_USE = new Set(["approve", "cancel", "dup_continue", "dup_join", "edit"]);

export function registerCallbackHandlers(bot: Bot, dispatch: (e: InboundEvent) => void) {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const decoded = decodeCallback(data);
    await ctx.answerCallbackQuery(decoded?.action === "approve" ? { text: "Approved, filing…" } : undefined).catch(() => {});
    if (!decoded) return;
    if (SINGLE_USE.has(decoded.action) && ctx.callbackQuery.message) {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
    const chatId = ctx.chat?.id ?? ctx.from.id;
    dispatch({
      kind: "callback",
      chatId: String(chatId),
      updateId: String(ctx.update.update_id),
      data,
      messageId: ctx.callbackQuery.message?.message_id ?? null,
      username: ctx.from.username ?? null,
    });
  });
}
