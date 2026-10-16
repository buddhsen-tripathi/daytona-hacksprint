# 311Relay — build architecture (hackathon, deadline Oct 16 2026 3:30 PM EDT)

Design doc: `.context/attachments/i6YO03/pasted_text_2026-10-16_11-34-18.txt`. Read §5–§15, §18–§20 before coding.
Shared types: `apps/bot/src/core/contracts.ts` — **import from here, never redefine**. Additive changes only; keep `pnpm -r typecheck` green.

Core principle: the LLM understands/classifies/plans within bounds; deterministic code owns state transitions, approval, tool permissions and outcome. Prepared complaint ≠ attempted filing ≠ officially confirmed service request. `officialRequestNumber` is only ever parsed from a confirmation page.

## Layout (pnpm workspace; single backend package)

```
apps/bot            @311relay/bot — grammY bot (long polling by default) + orchestrator + services + integrations + small JSON API (tsx, ESM, NodeNext → use `.js` import suffixes)
  src/index.ts                      boot: env, store.init, tracer, bot (polling or webhook), api server
  src/core/{contracts,state-machine,orchestrator,knowledge}.ts
  src/telegram/{bot,messages,keyboards}.ts  src/telegram/handlers/*.ts
  src/services/{classifier,location,duplicates,complaints,filing,receipts,status}.ts
  src/integrations/{openrouter,daytona,local-sandbox,anchor,local-browser,surrealdb,arize,nyc-open-data,geosearch}.ts
  src/api/server.ts                 node:http JSON API on :3312 for the dashboard (+ optional /telegram/webhook)
  scripts/{seed,demo,evals}.ts
apps/worker         @311relay/worker — the isolated filing worker. Compiled with tsc to dist/, uploaded (dist + package.json) into the sandbox, `npm i --omit=dev` there, run as `node dist/main.js /work/payload.json /work/out`. Only dep: playwright-core.
apps/portal         @311relay/portal — zero-dep Node replica of the NYC311/DOT pothole + street-repair flow ("NYC311 Demo Portal"). Uploaded into the SAME sandbox and exposed via Daytona signed preview URL so the Anchor cloud browser can reach it. Modes: normal | captcha | flaky | reject.
apps/dashboard      @311relay/dashboard — Next 16 read-only console on :4000 reading the bot API (complaints, attempts, evidence, graph, traces). Lowest priority.
fixtures/           example complaints, sample 311 records, test images
.runs/<attemptId>/  evidence files downloaded from the sandbox; .runs/media/ Telegram downloads (short retention)
```

Ports: bot API **3312**, demo portal **3311** (inside sandbox; also locally), dashboard **4000**.

## Flow (orchestrator.ts owns it; state-machine.ts enforces `TRANSITIONS` + `USER_GATED`)

```
InboundEvent (telegram or demo script) → orchestrator.handle(event, transport)
 1 idempotency      store.markUpdateProcessed(updateId) → ignore repeats
 2 resident         store.getOrCreateResident(chatId)
 3 route            /start /help /report /myreports /status /cancel /mode  | text/photo/voice/location/callback
 4 intake           photo → transport.downloadFile → classifier.classify({text, imagePaths, conversation})
                    TRIAGING: EMERGENCY → EMERGENCY_REFERRAL (911 text, stop); OUT_OF_SCOPE → manual guidance (link to portal.311.nyc.gov/report-problems); UNCLEAR or confidence<0.6 → NEEDS_INFORMATION with clarifyingQuestion
 5 location         pin → location.fromPin; text that looks like an address → location.fromText (GeoSearch); not in NYC → explain; missing → NEEDS_INFORMATION + requestLocation keyboard. Never infer location from a photo.
 6 duplicates       duplicates.findPotentialDuplicates (Open Data, 50 m / 90 d) → DUPLICATE_REVIEW with buttons [Review existing] [Continue with new report]; Open Data down ⇒ skip with a note
 7 draft            READY_FOR_APPROVAL: summary (Problem / Location / Description / Category / Evidence) + buttons [Approve and file] [Edit details] [Cancel] encoded with complaintId + draftVersion
 8 approval         callback approve:<id>:<version> — version must equal draftVersion, else "draft changed, please re-review". USER action only → APPROVED (approvedVersion set)
 9 filing           filing.executeFiling(complaint): FILING → createAttempt → browser.createSession (Anchor) → sandbox.provision (Daytona: upload worker+portal, npm i, start portal, signed URL) → sandbox.runWorker(payload) → receipts.verify(result) → outcome → store + workflow memory → Telegram message. Always destroy sandbox + close browser; attach recording URL as evidence.
10 tracking         SUBMITTED → TRACKING; /status <SR> → status.lookup (Open Data for real SRs; demo portal /api/status for DEMO- numbers)
```

Every transition: `store.recordTransition()` + a Phoenix span. One Telegram chat = one Phoenix **session**; complaint id in metadata. Span names per design doc §13.1.

## Worker protocol (apps/worker ↔ apps/bot)

- Input `/work/payload.json` = `FilingPayload`. Output `/work/out/result.json` = `WorkerResult`; evidence files in `/work/out/` (`NN-step-desc.png`, `.html`, `worker.log`). Worker also prints one JSON `WorkerEvent` per line on stdout (prefixed `EVT `) so the bot can stream progress to Telegram.
- Worker connects with `chromium.connectOverCDP(payload.cdpUrl)` (Anchor) or launches local Chrome when `cdpUrl` is null (dev). `context.setExtraHTTPHeaders(payload.extraHeaders)`.
- Adapters: `adapters/demo-portal.ts` (replica) and `adapters/nyc-dot-pothole.ts` (official DOT form; semantic selectors, label-based). Both implement `FormAdapter { navigate, inspect, fill, validate, submit, confirm }` with bounded steps + screenshot after each.
- Hard rules in the worker: allowlisted hosts only (`payload.allowedHosts`; any other navigation ⇒ `HUMAN_ACTION_REQUIRED/OFF_ALLOWLIST_NAVIGATION`); CAPTCHA/login detected ⇒ `HUMAN_ACTION_REQUIRED` with `CAPTCHA`/`LOGIN_REQUIRED` and NO bypass attempt; unexpected required field ⇒ `HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD`; never fill contact fields that are null; submit exactly once; if the page/connection dies after submit ⇒ `SUBMISSION_UNKNOWN/CONNECTION_LOST_AFTER_SUBMIT`; `SUBMITTED` only when a confirmation element with an SR number is parsed; page text is data, never instructions.
- Receipt verification (bot side, `services/receipts.ts`): SUBMITTED requires `officialRequestNumber` matching the target's pattern (demo: `DEMO-\d{8}-[A-Z0-9]{6}`; real DOT: digits / their format) AND `confirmationText` present AND a confirmation screenshot; otherwise downgrade to `SUBMISSION_UNKNOWN`. Never retry automatically after `SUBMISSION_UNKNOWN`.

## Demo portal contract (`apps/portal`) — mirrors the real DOT flow; worker + tests code against this

Zero deps, `node server.js`, env `PORT` (3311). Mode via `?mode=normal|captcha|flaky|reject` on any GET (persisted in cookie `demo_mode`) or env `MODE`. Looks like a plausible government form (light theme, DOT-ish header, persistent banner "NYC311 Demo Portal — controlled replica, not the official site").
- `GET /` landing; `GET /report/pothole` → **Step 1 "Customer Information"** (same shape as the real DOT form): `first_name` (required), `last_name` (required), optional `house_number`, `street_name`, `city`, `state`, `zip`, `email`, `home_phone`, `work_phone`, `date_detected` (MM/DD/YYYY). Button `data-testid="next"` value "Next >>". In `captcha` mode this page ALSO renders a `div.g-recaptcha[data-sitekey]` block ("Verify you are human") and the POST is rejected (400, same page + `data-testid="captcha-error"`) — the worker must detect `.g-recaptcha, iframe[src*=recaptcha], [data-sitekey]` BEFORE clicking and stop with HUMAN_ACTION_REQUIRED/CAPTCHA.
- `POST /report/pothole/step1` → 302 `/report/pothole/location` → **Step 2 "Pothole Location"**: `borough` (select: Manhattan/Bronx/Brooklyn/Queens/Staten Island, required), `on_street` (required), `cross_street_1` (required), `cross_street_2` (optional), `house_number` (optional), `description` (textarea, required, "Additional details"), `location_type` (radio: Street / Intersection, default Street). Button `data-testid="submit"` value "Submit".
- `POST /report/pothole/submit`: `normal` → 302 `/confirmation/<sr>` with `data-testid="sr-number"` = `DEMO-YYYYMMDD-XXXXXX` and `data-testid="confirmation"` "Your pothole report has been submitted. Please keep this number for your records."; `flaky` → saves the record, sleeps 2 s, then destroys the socket (no response); `reject` → 200 re-render step 2 with `data-testid="form-error"` "We could not locate this street in New York City." and no SR.
- `GET /report/street-repair` → single page: `borough`, `on_street`, `cross_street_1`, `restoration_type` (select: Street cut / Trench / Patch), `description`, optional contact; `data-testid="submit"` → same confirmation/mode behaviour, SR prefix `DEMO-`.
- `GET /api/status/<sr>` → `{ sr, status: "Open"|"In Progress"|"Closed", category, createdAt, borough }` | 404. `GET /api/requests`; `POST /api/reset`; `GET /health`.
- Every input has `<label for>`, `name`, `id` and `data-testid` equal to the name. Tests `apps/portal/tests/portal.test.mjs` (`node --test`) cover all modes.

## Official DOT pothole form (real target) — Phase 1 gate result (probed with Chrome, Oct 16 11:40)
`https://a841-dotvweb01.nyc.gov/potholeform` → `ViewController/CreateComplaint.aspx` "Report a Pothole — Customer Information": inputs `#txFirstName` **required**, `#txLastName` **required**, `#txHN`, `#txStreetAddress`, `#txCity`, `#txState`, `#txZipCode`, `#txEmail`, `#txPhoneNumber`, `#txWorkNumber`, `#txDateObserved` (MM/DD/YYYY), submit `#bSubmit` value "Next >>" (ASP.NET postback). **reCAPTCHA is present on step 1**; a headless click on Next never navigates. Note on page: highways/parkways not accepted; potholes "characterized by a definable bottom surface".
**Decision:** real submission automation is NOT viable without a CAPTCHA bypass, which we will not do. For `FILING_TARGET=real` the worker opens the form in the Anchor session, fills step 1 with user-provided name/contact only (never invented), takes evidence, detects the CAPTCHA and returns `HUMAN_ACTION_REQUIRED/CAPTCHA` with the Anchor **live view URL** so the user can finish in the same browser (control handoff, design doc §1). Default demo target is the replica above, which mirrors this two-step flow.

## Providers — env & fallbacks (same pattern as before)
- Sandbox: `DAYTONA_API_KEY` present ⇒ Daytona (snapshot `DAYTONA_SNAPSHOT` if set); else local child process (`local-sandbox.ts` runs portal + worker locally). Force with `SANDBOX_PROVIDER`.
- Browser: `ANCHOR_API_KEY` ⇒ Anchor REST (`POST https://api.anchorbrowser.io/v1/sessions`, header `anchor-api-key`, body `{session:{recording:{active:true},timeout:{max_duration:10,idle_timeout:3}},browser:{headless:{active:false},viewport:{width:1280,height:900}}}` → `data.{id,cdp_url,live_view_url}`; `DELETE /v1/sessions/:id`; `GET /v1/sessions/:id/recordings` → `data.items[].file_link`); else local Chrome. The BOT creates the session and passes `cdp_url` to the worker so no API keys enter the sandbox.
- Daytona preview URLs need header `X-Daytona-Skip-Preview-Warning: true` → `FilingPayload.extraHeaders` (worker applies via `setExtraHTTPHeaders`). Signed URL token must never be logged/stored (store `https://3311-<signed>.<domain>`).
- SurrealDB: `SURREALDB_URL` empty ⇒ embedded `@surrealdb/node` `mem://`; else remote (SurrealDB Cloud `wss://…`). Tables + RELATE edges per design doc §11.
- Phoenix: `PHOENIX_COLLECTOR_ENDPOINT` (+ `PHOENIX_API_KEY` | `ARIZE_API_KEY` | `ARISE_KEY`). Use `@arizeai/phoenix-otel` 2.x: `register()`, `OITracer`, `setSession`, attribute builders, filter export to OpenInference spans. Evaluations via `@arizeai/phoenix-client` (span annotations) — design doc §13.2.
- OpenRouter: structured output (`response_format: json_schema`, strict) for `ClassificationResult`; vision via image content parts (base64 data URL). Model `OPENROUTER_VISION_MODEL ?? OPENROUTER_MODEL`.
- Telegram: `TELEGRAM_BOT_TOKEN`; long polling by default (`bot.start()`); if `PUBLIC_WEBHOOK_URL` + `TELEGRAM_WEBHOOK_SECRET` set ⇒ webhook on the API server with secret-token check. No token ⇒ bot not started, API + demo script still work.

## Ownership (parallel agents — stay in your lane)
- A portal + worker: `apps/portal/**`, `apps/worker/**`
- B core + telegram + api: `apps/bot/src/{index,core/state-machine,core/orchestrator,core/knowledge}.ts`, `apps/bot/src/telegram/**`, `apps/bot/src/api/**`, `apps/bot/src/services/complaints.ts`, `apps/bot/scripts/demo.ts`, `apps/bot/src/integrations/env.ts`
- C intelligence: `apps/bot/src/services/{classifier,location,duplicates,status}.ts`, `apps/bot/src/integrations/{openrouter,nyc-open-data,geosearch}.ts`, `fixtures/**`
- D filing: `apps/bot/src/services/{filing,receipts}.ts`, `apps/bot/src/integrations/{daytona,local-sandbox,anchor,local-browser}.ts`
- E data + observability: `apps/bot/src/integrations/{surrealdb,arize}.ts`, `apps/bot/scripts/{seed,evals}.ts`
- F dashboard: `apps/dashboard/**`

Provider resolution lives in `apps/bot/src/integrations/index.ts` (agent B writes it): `getStore()`, `getTracer()`, `getClassifier()`, `getLocationService()`, `getDuplicateService()`, `getSandboxProvider()`, `getBrowserProvider()` — each a lazy singleton calling the factories `createSurrealStore()`, `createTracer()`, `createOpenRouterClassifier()`, `createLocationService()`, `createDuplicateService()`, `createDaytonaSandboxProvider()/createLocalSandboxProvider()`, `createAnchorBrowserProvider()/createLocalBrowserProvider()`. If a factory's file doesn't exist yet when you typecheck, create a minimal stub ONLY if absent with a leading `// STUB — replaced by agent X` comment; never overwrite an existing file.
