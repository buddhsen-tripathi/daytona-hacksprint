# Working on 311Relay with a coding agent

This file is read by Claude Code, Codex, Cursor and friends. Follow it before changing anything.

## Start from an issue
- Work is tracked in GitHub issues under three epics: **agent memory (#3)**, **category catalog & routing (#6)**, **learned required fields & self-repair (#10)**. Each task issue states its dependencies in its first line. Independent starting points: **#4** (memory service) and **#7** (catalog crawler).
- Before coding: `gh issue view <n>` and read the whole body. If a dependency isn't merged yet, build against the interface described in the dependency's issue and say so in a comment.
- Branch from `main`: `feat/<issue>-<slug>`. PR title starts with `#<issue>`; PR body ends with `Closes #<issue>` (or `Part of #<epic>` for partial work). No co-author trailers.

## Keep the issue checklist current
Every task issue ends with an **Implementation checklist**. As each item lands, edit the issue and tick it, then leave a one-line comment with what changed and the commit/PR link:

```bash
gh issue view <n> --json body -q .body > /tmp/body.md   # edit: "- [ ]" -> "- [x]"
gh issue edit <n> --body-file /tmp/body.md
gh issue comment <n> --body "Done: <what>. <PR/commit link>"
```
When your PR merges, tick your issue in the parent epic's task list and comment on any issue you unblocked. Do not open a PR with a stale checklist.

## Ground rules that keep the product honest
- The LLM classifies and plans; deterministic code owns state transitions, approval, and outcomes. Only a resident's button tap moves a draft to `APPROVED`.
- Official request/reference numbers are only ever parsed from a confirmation page. Never synthesize one.
- The worker never bypasses CAPTCHA or login, never fills contact fields the resident didn't give, submits at most once, and never retries after `SUBMISSION_UNKNOWN`.
- Real submissions require `ALLOW_REAL_SUBMIT=1` **and** an approved draft version. Default is dry run.
- Contracts live in `apps/bot/src/core/contracts.ts` and `apps/worker/src/protocol.ts` (keep in sync). Changes must be additive.

## Local workflow
```bash
pnpm install && pnpm --filter @311relay/worker build
pnpm -r typecheck && pnpm --filter @311relay/bot exec vitest run
pnpm check                                      # exactly what CI runs: typecheck, worker build, bot tests
pnpm demo -- --scenario subway --no-filing      # intake → card, no browser
pnpm demo -- --scenario subway                  # dry run on Daytona + Anchor (keys in .env)
pnpm dev                                        # bot + API on :3312 (Telegram polling if TELEGRAM_BOT_TOKEN is set)
pnpm dev:dashboard                              # console on :4000
```
- **Never start a second bot instance with the real `TELEGRAM_BOT_TOKEN`** — Telegram allows one poller and the live bot will fight it (409). For local testing set `TELEGRAM_BOT_TOKEN=` empty and `PORT_API=3399`.
- Keep secrets out of logs, traces, screenshots and issues. The root `.env` is gitignored.
- Architecture, protocols and ownership: `ARCHITECTURE.md`. Product scope and setup: `README.md`.
