/** grammY implementation of the transport-agnostic Transport contract. */
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { type Api, GrammyError, InputFile } from "grammy";
import type { OutboundMessage, Transport } from "../core/contracts.js";
import { stripHtml } from "./messages.js";
import { locationKeyboard, toInlineKeyboard } from "./keyboards.js";

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".oga": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };

export function createTelegramTransport(api: Api, token: string): Transport {
  async function sendNew(msg: OutboundMessage, parse: boolean): Promise<number> {
    const reply_markup = msg.requestLocation ? locationKeyboard() : msg.buttons?.length ? toInlineKeyboard(msg.buttons) : undefined;
    const text = parse ? msg.text : stripHtml(msg.text);
    const parse_mode = parse ? msg.parseMode : undefined;
    if (msg.photoPath) {
      const m = await api.sendPhoto(msg.chatId, new InputFile(msg.photoPath), { caption: text.slice(0, 1024), parse_mode, reply_markup });
      return m.message_id;
    }
    const m = await api.sendMessage(msg.chatId, text.slice(0, 4096), { parse_mode, reply_markup, link_preview_options: { is_disabled: true } });
    return m.message_id;
  }

  return {
    async send(msg) {
      if (msg.editMessageId != null) {
        try {
          await api.editMessageText(msg.chatId, msg.editMessageId, msg.text.slice(0, 4096), {
            parse_mode: msg.parseMode,
            reply_markup: msg.buttons?.length ? toInlineKeyboard(msg.buttons) : undefined,
            link_preview_options: { is_disabled: true },
          });
          return { messageId: msg.editMessageId };
        } catch (err) {
          if (err instanceof GrammyError && /not modified/i.test(err.description)) return { messageId: msg.editMessageId };
          // fall through to sending a new message
        }
      }
      try {
        return { messageId: await sendNew(msg, true) };
      } catch (err) {
        if (err instanceof GrammyError && /parse entities|can't parse/i.test(err.description)) {
          return { messageId: await sendNew(msg, false) };
        }
        if (err instanceof GrammyError && /BUTTON_URL_INVALID/i.test(err.description)) {
          return { messageId: await sendNew({ ...msg, buttons: msg.buttons?.map((r) => r.filter((b) => !b.url)).filter((r) => r.length) }, true) };
        }
        throw err;
      }
    },

    async downloadFile(fileId, destDir) {
      const file = await api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram returned no file_path");
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      const ext = extname(file.file_path) || ".jpg";
      mkdirSync(destDir, { recursive: true });
      const path = resolve(destDir, `${file.file_unique_id}${ext}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      return { path, mime: MIME[ext.toLowerCase()] ?? res.headers.get("content-type") };
    },

    async ackCallback(callbackQueryId, text) {
      await api.answerCallbackQuery(callbackQueryId, text ? { text } : undefined);
    },

    async typing(chatId) {
      await api.sendChatAction(chatId, "typing");
    },
  };
}
