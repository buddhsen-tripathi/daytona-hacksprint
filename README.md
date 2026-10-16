# 311Relay

**See something. Send it. Track it.**

311Relay is a Telegram agent that turns a photo or message about a city problem into a reviewable, trackable NYC311 service request.

1. Send a photo, a description, or a voice note to the bot.
2. Share the location (pin or address).
3. The agent classifies the issue against an allowlist of official NYC311 categories, asks only for what is missing, and checks NYC Open Data for a possible existing request nearby.
4. You review the draft and **explicitly approve** filing.
5. A disposable **Daytona** sandbox runs an isolated filing worker that drives a real **Anchor Browser** session through the reporting form, with screenshots as evidence.
6. You get the official request number if the portal confirmed it, or an honest hand-off when a human has to finish (CAPTCHA, login, unexpected questions).
7. `/status` checks the request later.

A prepared complaint is not an attempted filing, and an attempted filing is not a confirmed service request. The bot never invents request numbers and never retries after an uncertain submission.

Built for Daytona HackSprint NYC, Oct 16 2026. Design doc in `.context/attachments/`; build plan in `ARCHITECTURE.md`.

## Stack

| Piece | Tech |
|---|---|
| Interface | Telegram Bot API via grammY (long polling by default) |
| Reasoning | OpenRouter, strict JSON-schema structured output, vision for photos |
| Execution | Daytona sandbox per filing attempt, hosting the worker and the demo portal |
| Browser | Anchor Browser session, Playwright over CDP from inside the sandbox |
| Data | SurrealDB (Cloud or embedded `mem://`) with a graph of residents, complaints, locations, official requests |
| Public records | NYC Open Data `erm2-nwe9` for duplicate detection and status |
| Observability | Arize Phoenix via `@arizeai/phoenix-otel`, one session per chat, evaluations per scenario |

## Layout

```
apps/bot         grammY bot + orchestrator + services + integrations + JSON API (:3312)
apps/worker      isolated filing worker (runs inside the Daytona sandbox)
apps/portal      zero-dependency replica of the NYC DOT pothole flow for safe repeated demos (:3311)
apps/dashboard   read-only operations console (:4000)
fixtures/        example complaints, sample 311 records, test photos
```

## Quick start

```bash
pnpm install
cp .env.example .env     # fill in TELEGRAM_BOT_TOKEN and sponsor keys
pnpm --filter @311relay/worker build
pnpm dev                  # bot + API
pnpm dev:dashboard        # optional console on :4000
```

Providers auto-select: Daytona and Anchor are used when their keys are present, otherwise a local child process and local Chrome. SurrealDB is embedded when `SURREALDB_URL` is empty. The root `.env` is read by every app.

Without a Telegram token you can still drive the whole flow:

```bash
pnpm demo -- --scenario happy        # photo → location → duplicates → approve → filing
pnpm demo -- --scenario captcha      # hand-off path
pnpm --filter @311relay/bot evals    # the 9 evaluation scenarios, results pushed to Phoenix
```

## Why the demo portal

The official DOT pothole form (`a841-dotvweb01.nyc.gov/potholeform`) has reCAPTCHA on its first step. We do not bypass CAPTCHAs. With `FILING_TARGET=real` the worker fills only user-provided details, stops at the CAPTCHA, and hands you the Anchor live-view link to finish in the same browser. For repeatable demos, `FILING_TARGET=demo` (default) runs a faithful two-step replica of that form inside the sandbox, with `/mode normal|captcha|flaky|reject` to exercise the confirmed, hand-off, unknown, and failed outcomes.

## How a filing attempt runs (about 25 seconds on Daytona + Anchor)

1. The bot creates an Anchor browser session (recording on) and a fresh Daytona sandbox from the `daytona-medium` snapshot in parallel.
2. It uploads the compiled worker and the demo portal into the sandbox, installs `playwright-core`, starts the portal, and exposes it through a signed, time-limited preview URL.
3. The sandbox has no general internet egress on this Daytona tier (only the npm registry), so the bot bridges the Anchor CDP websocket into the sandbox over a second signed preview URL. The Anchor API key and CDP URL never enter the sandbox.
4. The worker drives the form step by step (navigate, inspect, fill, validate, submit, confirm), writing a screenshot after every step and a structured `result.json`.
5. The bot downloads the evidence, verifies the receipt (request number pattern, confirmation text, confirmation screenshot), persists the attempt and a workflow-memory pattern to SurrealDB, destroys the sandbox, and replies on Telegram.

Every step is a span in Phoenix under the chat's session, and the evaluation suite (`scripts/evals.ts`) annotates each scenario's trace with the six evaluation dimensions from the design doc.

## Safety rules the code enforces

- Only a user tap on "Approve and file" moves a draft to APPROVED, and the approval is bound to the draft version.
- The worker may only navigate allowlisted hosts, never fills contact fields the user did not provide, submits at most once, and stops on CAPTCHA or login.
- `SUBMITTED` requires a parsed confirmation with a request number and a screenshot; anything less is `SUBMISSION_UNKNOWN` or `FAILED`.
- Emergencies are referred to 911 and never filed.
