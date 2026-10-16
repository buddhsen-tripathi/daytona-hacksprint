---
name: telegram-bot-grammy
description: |
  Telegram Bot development skill using grammY framework, TypeScript, Drizzle ORM, Vitest testing, Biome linting, deployed to Cloudflare Workers with D1 database.
  Use cases:
  (1) Creating new Telegram Bot projects
  (2) Adding commands or features to existing Bots
  (3) Configuring Cloudflare Workers deployment
  (4) Setting up Drizzle + D1 database integration
  (5) Writing Bot test cases
  (6) Configuring Git hooks and GitHub Actions CI/CD
---

# Telegram Bot Development Skill (grammY + Cloudflare Workers)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [grammY](https://grammy.dev) |
| Language | TypeScript |
| Runtime | Cloudflare Workers |
| ORM | Drizzle ORM |
| Database | Cloudflare D1 (SQLite) |
| Testing | Vitest |
| Linting | Biome |
| Package Manager | pnpm |
| Git Hooks | Husky + lint-staged |
| CI/CD | GitHub Actions (multi-environment) |

## Environment Configuration

| Branch | Environment | Worker Name | Database |
|--------|-------------|-------------|----------|
| `dev` | development | my-telegram-bot-dev | telegram-bot-db-dev |
| `main` | production | my-telegram-bot | telegram-bot-db |

## Project Initialization

### 1. Create Project

```bash
pnpm create cloudflare@latest my-telegram-bot
# Select: "Hello World" Worker, TypeScript: Yes, Git: Yes, Deploy: No

cd my-telegram-bot
```

### 2. Install Dependencies

```bash
# Core dependencies
pnpm add grammy drizzle-orm

# Dev dependencies
pnpm add -D drizzle-kit vitest @vitest/coverage-v8 @biomejs/biome husky lint-staged
```

### 3. Create Drizzle Config (`drizzle.config.ts`)

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
```

### 4. Define Database Schema (`src/db/schema.ts`)

```typescript
import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    telegramId: text("telegram_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("users_telegram_id_unique").on(table.telegramId)]
);

export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value"),
  },
  (table) => [uniqueIndex("settings_user_id_key_unique").on(table.userId, table.key)]
);

export const usersRelations = relations(users, ({ many }) => ({
  settings: many(settings),
}));
```

### 5. Configure wrangler.toml (Multi-Environment)

```toml
name = "my-telegram-bot"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[env.dev]
name = "my-telegram-bot-dev"

[env.dev.vars]
BOT_INFO = """{ "id": 123456789, "is_bot": true, "first_name": "MyBotDev", "username": "my_bot_dev" }"""

[[env.dev.d1_databases]]
binding = "DB"
database_name = "telegram-bot-db-dev"
database_id = "<DEV_DATABASE_ID>"

[env.production]
name = "my-telegram-bot"

[env.production.vars]
BOT_INFO = """{ "id": 987654321, "is_bot": true, "first_name": "MyBot", "username": "my_bot" }"""

[[env.production.d1_databases]]
binding = "DB"
database_name = "telegram-bot-db"
database_id = "<PRODUCTION_DATABASE_ID>"
```

### 6. Create D1 Databases

```bash
# Create development database
pnpm exec wrangler d1 create telegram-bot-db-dev

# Create production database
pnpm exec wrangler d1 create telegram-bot-db

# Copy database_id to wrangler.toml
```

### 7. Database Migrations

```bash
# Create migration file
pnpm exec wrangler d1 migrations create telegram-bot-db-dev init

# Generate SQL files from Drizzle schema
pnpm exec drizzle-kit generate

# Apply to development
pnpm exec wrangler d1 migrations apply telegram-bot-db-dev --local
pnpm exec wrangler d1 migrations apply telegram-bot-db-dev --remote

# Apply to production
pnpm exec wrangler d1 migrations apply telegram-bot-db --remote
```

### 8. Configure Git Hooks

```bash
pnpm exec husky init
```

`.husky/pre-commit`:
```bash
pnpm exec lint-staged
pnpm test
```

## Code Structure

### Entry File (`src/index.ts`)

```typescript
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { Bot, webhookCallback } from "grammy";
import { users } from "./db/schema";

export interface Env {
  BOT_TOKEN: string;
  BOT_INFO: string;
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = drizzle(env.DB);

    const bot = new Bot(env.BOT_TOKEN, {
      botInfo: JSON.parse(env.BOT_INFO),
    });

    bot.command("start", async (ctx) => {
      const user = ctx.from;
      if (user) {
        await db
          .insert(users)
          .values({
            telegramId: String(user.id),
            username: user.username ?? null,
            firstName: user.first_name ?? null,
          })
          .onConflictDoUpdate({
            target: users.telegramId,
            set: {
              username: user.username ?? null,
              firstName: user.first_name ?? null,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          });
      }
      await ctx.reply("Welcome to the Bot!");
    });

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};
```

## GitHub Actions CI/CD

### Workflow Overview

| Branch | Trigger | Target Environment |
|--------|---------|-------------------|
| `dev` | push | development (my-telegram-bot-dev) |
| `main` | push | production (my-telegram-bot) |
| PR | - | Tests only, no deployment |

### `.github/workflows/ci.yml`

```yaml
name: CI/CD

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main, dev]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run test

  deploy-dev:
    needs: test
    if: github.ref == 'refs/heads/dev' && github.event_name == 'push'
    environment: development
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
      - run: pnpm install --frozen-lockfile
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          environment: dev

  deploy-production:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
      - run: pnpm install --frozen-lockfile
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          environment: production
```

## GitHub Configuration

**Secrets** (Settings -> Secrets and variables -> Actions):
- `CLOUDFLARE_API_TOKEN`: Cloudflare API Token

**Environments** (Settings -> Environments):
- `development`: Optional protection rules
- `production`: Recommend configuring Required reviewers

## Deployment

### Manual Deployment

```bash
# Deploy to development
pnpm exec wrangler deploy --env dev

# Deploy to production
pnpm exec wrangler deploy --env production
```

### Set Secrets

```bash
# Development
pnpm exec wrangler secret put BOT_TOKEN --env dev

# Production
pnpm exec wrangler secret put BOT_TOKEN --env production
```

### Set Webhook

```bash
# Development
curl "https://api.telegram.org/bot<DEV_TOKEN>/setWebhook?url=https://my-telegram-bot-dev.<subdomain>.workers.dev/"

# Production
curl "https://api.telegram.org/bot<PROD_TOKEN>/setWebhook?url=https://my-telegram-bot.<subdomain>.workers.dev/"
```

## References

- [grammY Documentation](https://grammy.dev/guide/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Wrangler Environments](https://developers.cloudflare.com/workers/wrangler/environments/)
