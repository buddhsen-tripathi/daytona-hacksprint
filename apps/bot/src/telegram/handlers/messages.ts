import type { Bot } from "grammy";
import type { InboundEvent } from "../../core/contracts.js";

export function registerMessageHandlers(bot: Bot, dispatch: (e: InboundEvent) => void) {
  bot.on("message:text", (ctx) => {
    dispatch({ kind: "text", chatId: String(ctx.chat.id), updateId: String(ctx.update.update_id), text: ctx.message.text, username: ctx.from?.username ?? null });
  });

  bot.on("message:photo", (ctx) => {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;
    dispatch({
      kind: "photo",
      chatId: String(ctx.chat.id),
      updateId: String(ctx.update.update_id),
      fileId: largest.file_id,
      caption: ctx.message.caption ?? null,
      username: ctx.from?.username ?? null,
    });
  });

  bot.on("message:voice", (ctx) => {
    dispatch({
      kind: "voice",
      chatId: String(ctx.chat.id),
      updateId: String(ctx.update.update_id),
      fileId: ctx.message.voice.file_id,
      durationSec: ctx.message.voice.duration ?? null,
      username: ctx.from?.username ?? null,
    });
  });

  bot.on("message:location", (ctx) => {
    dispatch({
      kind: "location",
      chatId: String(ctx.chat.id),
      updateId: String(ctx.update.update_id),
      latitude: ctx.message.location.latitude,
      longitude: ctx.message.location.longitude,
      username: ctx.from?.username ?? null,
    });
  });
}
