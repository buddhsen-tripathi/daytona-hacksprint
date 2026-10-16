import type { Bot } from "grammy";
import type { InboundEvent } from "../../core/contracts.js";

export const BOT_COMMANDS = [
  { command: "start", description: "Introduction and how it works" },
  { command: "report", description: "Start a new report" },
  { command: "myreports", description: "Your drafts and filed requests" },
  { command: "status", description: "Check a service request status" },
  { command: "cancel", description: "Cancel the current draft" },
  { command: "help", description: "Supported problems and safety info" },
  { command: "name", description: "Set contact name for official forms" },
  { command: "mode", description: "Demo portal mode (normal|captcha|flaky|reject)" },
];

const CMD_RE = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): { command: string; args: string } | null {
  const m = CMD_RE.exec(text.trim());
  return m ? { command: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** Commands arrive as text messages; registered first so they never reach the text handler. */
export function registerCommandHandlers(bot: Bot, dispatch: (e: InboundEvent) => void) {
  bot.on("message:text", async (ctx, next) => {
    const parsed = ctx.message.text.startsWith("/") ? parseCommand(ctx.message.text) : null;
    if (!parsed) return next();
    dispatch({
      kind: "command",
      chatId: String(ctx.chat.id),
      updateId: String(ctx.update.update_id),
      command: parsed.command,
      args: parsed.args,
      username: ctx.from?.username ?? null,
    });
  });
}
