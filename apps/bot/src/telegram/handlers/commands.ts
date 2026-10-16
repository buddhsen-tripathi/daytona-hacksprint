import type { Bot } from "grammy";
import type { InboundEvent } from "../../core/contracts.js";

export const BOT_COMMANDS = [
  { command: "start", description: "What I do" },
  { command: "report", description: "Report a problem" },
  { command: "myreports", description: "Your reports" },
  { command: "status", description: "Check a report's status" },
  { command: "name", description: "Your name for official forms" },
  { command: "email", description: "Your email for official replies" },
  { command: "cancel", description: "Cancel the current draft" },
  { command: "help", description: "What I can file and how" },
];

/** Bot profile texts (set by scripts/set-bot-profile.ts). Description ≤ 512 chars, short description ≤ 120. */
export const BOT_DESCRIPTION =
  "Hey, I'm 311Relay 👋\n\nDrop a photo or describe what's wrong and I'll figure out where it has to be reported and file it for you, in a real browser. You review every report before it's sent.\n\nToday I file subway delays with the MTA. More coming.\n\nFor emergencies, call 911.";
export const BOT_SHORT_DESCRIPTION = "Drop a photo or describe what's wrong. I find where it has to be reported and file it for you.";

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
