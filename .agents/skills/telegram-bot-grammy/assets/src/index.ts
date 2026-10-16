import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "grammy";
import { Bot, webhookCallback } from "grammy";
import { users } from "./db/schema";

export interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  DB: D1Database;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    // Initialize Drizzle with D1 binding
    const db = drizzle(env.DB);

    // Initialize Bot
    const bot = new Bot(env.BOT_TOKEN, {
      botInfo: JSON.parse(env.BOT_INFO),
    });

    // /start command - save user info
    bot.command("start", async (ctx: Context) => {
      const user = ctx.from;
      if (user) {
        await db
          .insert(users)
          .values({
            telegramId: String(user.id),
            username: user.username ?? null,
            firstName: user.first_name ?? null,
            lastName: user.last_name ?? null,
          })
          .onConflictDoUpdate({
            target: users.telegramId,
            set: {
              username: user.username ?? null,
              firstName: user.first_name ?? null,
              lastName: user.last_name ?? null,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          });
      }
      await ctx.reply("Welcome to the Bot! Send /help for help.");
    });

    // /help command
    bot.command("help", async (ctx: Context) => {
      await ctx.reply("Available commands:\n/start - Start\n/help - Help");
    });

    // Handle other messages
    bot.on("message", async (ctx: Context) => {
      await ctx.reply("Message received!");
    });

    // Handle webhook
    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};
