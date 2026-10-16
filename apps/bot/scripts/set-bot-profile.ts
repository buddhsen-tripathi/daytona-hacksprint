/**
 * Sets the Telegram bot profile: description (empty-chat screen), short description (profile/share)
 * and the command menu. Safe to run while the bot is polling (these are plain Bot API calls).
 *
 *   pnpm --filter @311relay/bot exec tsx scripts/set-bot-profile.ts
 */
import { Api } from "grammy";
import { loadDotEnv } from "../src/integrations/env.js";
import { BOT_COMMANDS, BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION } from "../src/telegram/handlers/commands.js";

loadDotEnv();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}
const api = new Api(token);
for (const c of BOT_COMMANDS) if (c.description.length > 40) console.warn(`warning: /${c.command} description is ${c.description.length} chars`);
await api.setMyDescription(BOT_DESCRIPTION);
await api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
await api.setMyCommands(BOT_COMMANDS);
const me = await api.getMe();
console.log(`@${me.username}: description, short description and ${BOT_COMMANDS.length} commands set.`);
console.log((await api.getMyCommands()).map((c) => `/${c.command} — ${c.description}`).join("\n"));
