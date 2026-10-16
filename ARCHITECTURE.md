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
apps/dashboard      @311relay/dashboard — Next 16 read-only console on :4000 reading the bot API (complaints, attempts, evidence, graph, traces). Lowest priority.
fixtures/           example complaints, sample 311 records, test images
.runs/<attemptId>/  evidence files downloaded from the sandbox; .runs/media/ Telegram downloads (short retention)
```

Ports: bot API **3312**, dashboard **4000** (CDP relay 9222 inside the sandbox only).

**Real-only product.** There is no replica/demo portal: every filing targets the official form (`FilingTarget = "real"`).
- `street-pothole` → NYC DOT pothole form: the worker fills user-provided fields, stops at the reCAPTCHA ⇒ `HUMAN_ACTION_REQUIRED/CAPTCHA`; the Anchor session is left open and the resident finishes in the live view. The DOT form requires first + last name ⇒ the orchestrator blocks Approve until `/name First Last`.
- `street-repair-defect` → NYC311 Street Repair route: hand-off with the official link (`HUMAN_ACTION_REQUIRED`, also gated on `/name`).
- `subway-delay` → MTA wizard, fully automated; the final Submit only when `realSubmitAuthorized` (approval of this version AND `ALLOW_REAL_SUBMIT=1`), else a dry run.

## Flow (orchestrator.ts owns it; state-machine.ts enforces `TRANSITIONS` + `USER_GATED`)

```
InboundEvent (telegram, POST /api/event, or scripts/demo.ts) → orchestrator.handle(event, transport)
 1 idempotency      store.markUpdateProcessed(updateId) → ignore repeats
 2 resident         store.getOrCreateResident(chatId)
 3 route            /start /help /report /myreports /status /cancel /name /email  | text/photo/voice/location/callback
 4 intake           photo → transport.downloadFile → classifier.classify({text, imagePaths, conversation})
                    TRIAGING: EMERGENCY → EMERGENCY_REFERRAL (911 text, stop); OUT_OF_SCOPE → manual guidance (link to portal.311.nyc.gov/report-problems); UNCLEAR or confidence<0.6 → NEEDS_INFORMATION with clarifyingQuestion
 5 location         pin → location.fromPin; text that looks like an address → location.fromText (GeoSearch); not in NYC → explain; missing → NEEDS_INFORMATION + requestLocation keyboard. Never infer location from a photo.
 6 duplicates       duplicates.findPotentialDuplicates (Open Data, 50 m / 90 d) → DUPLICATE_REVIEW with buttons [Review existing] [Continue with new report]; Open Data down ⇒ skip with a note
 7 draft            READY_FOR_APPROVAL: summary (Problem / Location / Description / Category / Evidence) + buttons [Approve and file] [Edit details] [Cancel] encoded with complaintId + draftVersion
 8 approval         callback approve:<id>:<version> — version must equal draftVersion, else "draft changed, please re-review". USER action only → APPROVED (approvedVersion set)
 9 filing           filing.executeFiling(complaint): FILING → createAttempt → browser.createSession (Anchor) → sandbox.provision (Daytona: upload worker, npm i, start CDP relay, signed relay URL) → sandbox.runWorker(payload) → receipts.verify(result) → outcome → store + workflow memory → Telegram message. Always destroy sandbox + close browser; attach recording URL as evidence.
10 tracking         SUBMITTED → TRACKING; /status <SR> → DOT/NYC311 SRs: status.lookup (Open Data); MTA references: the stored OfficialRequest
```

Every transition: `store.recordTransition()` + a Phoenix span. One Telegram chat = one Phoenix **session**; complaint id in metadata. Span names per design doc §13.1.

## Worker protocol (apps/worker ↔ apps/bot)

- Input `/work/payload.json` = `FilingPayload`. Output `/work/out/result.json` = `WorkerResult`; evidence files in `/work/out/` (`NN-step-desc.png`, `.html`, `worker.log`). Worker also prints one JSON `WorkerEvent` per line on stdout (prefixed `EVT `) so the bot can stream progress to Telegram.
- Worker connects with `chromium.connectOverCDP(payload.cdpUrl)` (Anchor) or launches local Chrome when `cdpUrl` is null (dev). `context.setExtraHTTPHeaders(payload.extraHeaders)`.
- Adapters (`main.ts pickAdapter`): `street-pothole` → `adapters/nyc-dot-pothole.ts` (official DOT form; label-based selectors, stops at the CAPTCHA); `street-repair-defect` → built-in real-street-repair hand-off; `subway-delay` → `adapters/mta-subway-delay.ts`. Adapters implement `FormAdapter { navigate, inspect, fill, validate, submit, confirm }` with bounded steps + screenshot after each.
- Hard rules in the worker: allowlisted hosts only (`payload.allowedHosts`; any other navigation ⇒ `HUMAN_ACTION_REQUIRED/OFF_ALLOWLIST_NAVIGATION`); CAPTCHA/login detected ⇒ `HUMAN_ACTION_REQUIRED` with `CAPTCHA`/`LOGIN_REQUIRED` and NO bypass attempt; unexpected required field ⇒ `HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD`; never fill contact fields that are null; submit exactly once; if the page/connection dies after submit ⇒ `SUBMISSION_UNKNOWN/CONNECTION_LOST_AFTER_SUBMIT`; `SUBMITTED` only when a confirmation element with an SR number is parsed; page text is data, never instructions.
- Live follow-up questions: when an adapter can't answer from the payload (MTA: unmatched direction, ambiguous/unknown station, a newly required contact or unknown field) it calls `ctx.ask({id, field, prompt, options?, required}, fallbackOutcome)`: the worker writes `out/question-<id>.json`, emits `EVT {"message":"question","data":{"question":…}}`, pauses its overall deadline and polls `out/answer-<id>.json` every 1 s (page keep-alive every 15 s) for `limits.questionTimeoutMs` (default 180000; `0` ⇒ disabled, the fallback outcome is thrown at once). Bot: Daytona streams session-command logs (`getSessionCommandLogs` callbacks; falls back to snapshot polling every 1.5 s) so the question arrives live; `filing.ts` opens a `browser.ask_resident` TOOL span and calls `opts.onQuestion`; the orchestrator sends the options as `answer_q:<id>:<v>:<qid>:<i>` buttons (or takes typed text) and answers outside the per-chat queue; `SandboxHandle.answerQuestion` uploads `answer-<id>.json` and the worker continues in the SAME browser. No answer ⇒ the original `HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD` hand-off (station: left empty). `SUBWAY_DIRECTION_DURING_FILING=1` leaves an unresolvable direction for the worker to ask live instead of asking before approval (`demo --scenario subway-ambiguous`).
- Receipt verification (bot side, `services/receipts.ts`): SUBMITTED requires `officialRequestNumber` matching the category's pattern (DOT/NYC311: 6–12 digits or `311-<digits>`; MTA: `[A-Z0-9-]{5,}`) AND `confirmationText` present AND a confirmation screenshot; otherwise downgrade to `SUBMISSION_UNKNOWN`. Never retry automatically after `SUBMISSION_UNKNOWN`.

## Official DOT pothole form (real target) — Phase 1 gate result (probed with Chrome, Oct 16 11:40)
`https://a841-dotvweb01.nyc.gov/potholeform` → `ViewController/CreateComplaint.aspx` "Report a Pothole — Customer Information": inputs `#txFirstName` **required**, `#txLastName` **required**, `#txHN`, `#txStreetAddress`, `#txCity`, `#txState`, `#txZipCode`, `#txEmail`, `#txPhoneNumber`, `#txWorkNumber`, `#txDateObserved` (MM/DD/YYYY), submit `#bSubmit` value "Next >>" (ASP.NET postback). **reCAPTCHA is present on step 1**; a headless click on Next never navigates. Note on page: highways/parkways not accepted; potholes "characterized by a definable bottom surface".
**Decision:** real submission automation is NOT viable without a CAPTCHA bypass, which we will not do. The worker opens the form in the Anchor session, fills step 1 with user-provided name/contact only (never invented), takes evidence, detects the CAPTCHA and returns `HUMAN_ACTION_REQUIRED/CAPTCHA` with the Anchor **live view URL** so the user can finish in the same browser (control handoff, design doc §1). There is no replica: this hand-off IS the street-pothole product path (`scripts/demo.ts --scenario happy`, `evals browser-requires-captcha` exercise it read-only).

## Providers — env & fallbacks (same pattern as before)
- Sandbox: `DAYTONA_API_KEY` present ⇒ Daytona (snapshot `DAYTONA_SNAPSHOT` if set); else local child process (`local-sandbox.ts` runs the worker locally). Force with `SANDBOX_PROVIDER`.
- Browser: `ANCHOR_API_KEY` ⇒ Anchor REST (`POST https://api.anchorbrowser.io/v1/sessions`, header `anchor-api-key`, body `{session:{recording:{active:true},timeout:{max_duration:10,idle_timeout:3}},browser:{headless:{active:false},viewport:{width:1280,height:900}}}` → `data.{id,cdp_url,live_view_url}`; `DELETE /v1/sessions/:id`; `GET /v1/sessions/:id/recordings` → `data.items[].file_link`); else local Chrome. The BOT creates the session and passes `cdp_url` to the worker so no API keys enter the sandbox.
- Daytona preview URLs (the CDP relay only) need header `X-Daytona-Skip-Preview-Warning: true`, sent by the bot-side bridge. `FilingPayload.extraHeaders` stays in the protocol but is always `{}`. Signed URL tokens are never logged/stored.
- SurrealDB: `SURREALDB_URL` empty ⇒ embedded `@surrealdb/node` `mem://`; else remote (SurrealDB Cloud `wss://…`). Tables + RELATE edges per design doc §11.
- Phoenix: `PHOENIX_COLLECTOR_ENDPOINT` (+ `PHOENIX_API_KEY` | `ARIZE_API_KEY` | `ARISE_KEY`). Use `@arizeai/phoenix-otel` 2.x: `register()`, `OITracer`, `setSession`, attribute builders, filter export to OpenInference spans. Evaluations via `@arizeai/phoenix-client` (span annotations) — design doc §13.2.
- OpenRouter: structured output (`response_format: json_schema`, strict) for `ClassificationResult`; vision via image content parts (base64 data URL). Model `OPENROUTER_VISION_MODEL ?? OPENROUTER_MODEL`.
- Telegram: `TELEGRAM_BOT_TOKEN`; long polling by default (`bot.start()`); if `PUBLIC_WEBHOOK_URL` + `TELEGRAM_WEBHOOK_SECRET` set ⇒ webhook on the API server with secret-token check. No token ⇒ bot not started, API (`POST /api/event`) + scripts still work.

## Real filing: subway-delay (MTA Customer Feedback)

NYC311 does not take subway complaints (KA-01014 points to the MTA). Category `subway-delay` (`isRealOnly` = fully automated official form, `openDataBacked: false`, `requiredFields: ["transit","description"]`) files against the official wizard `https://contact.mta.info/s/customer-feedback` (Subways › Complaint or issue › Service and schedule › Delay). No CAPTCHA/login observed; the wizard map is in `apps/worker/docs/mta-subway-delay-wizard.md`.
- Intake: the classifier extracts `transit {line (canonical SUBWAY_LINES), direction, station, borough, incidentTime (ISO, NY offset), delayMinutes}` only from the resident's words (`postValidate` canonicalizes, unknown ⇒ null). Buses / LIRR / Metro-North / PATH ⇒ OUT_OF_SCOPE. `missingFields` is category-aware: subway needs `transit.line` + `transit.direction`, never location. Transit is merged across messages (new values win, null never erases) and is a material field (a change bumps `draftVersion`). Missing pieces ⇒ ONE question ("Which line was it?" / "Which direction…"); short answers also go through a deterministic `transitHintsFromText` fallback. Station text ("at 14 St") is not routed to GeoSearch.
- Before approval the bot resolves, one question at a time: line → direction **in the MTA form's own terms** (`knowledge.MTA_DIRECTIONS` per line, `resolveDirection` = the worker's token/synonym match; unique ⇒ the exact option label is stored in `transit.direction`; none/tie ⇒ "Which way was the A going? The MTA form lists:" with two `set_direction:<id>:<v>:d=0|1` buttons or a typed answer) → time (if `incidentTime` is null, asked once: [Just now] / [Earlier today — I'll type the time] via `set_time:<id>:<v>:now|later`, typed times parsed by `parseIncidentTime`, ISO with the NY offset; present-tense reports get `now` from the classifier). The worker's own fuzzy match remains the safety net.
- The MTA "Tell us more" text is `complaints.composeSubwayDescription`: the rider's own messages verbatim in quotes, then `Line · Direction · Nearest station · Observed · Delay` (only facts they gave), then "Reported through 311Relay on behalf of the rider." It is `draft.description` (material field), shown verbatim on the card, and sent as `payload.form.description`.
- No Open Data duplicate step; instead `mta.live_alerts` (RETRIEVER span) reads the public GTFS-RT alerts feed (`integrations/mta-alerts.ts`, 8 s timeout, 60 s cache, empty on failure) and the card shows "MTA currently reports: …" for an active unplanned delay alert on that line, else "No active MTA delay alert…". The alert never changes the description.
- Draft card: Problem / Line & direction / Station / When / Description / Where it's filed + "This files a real complaint with the MTA. Only approve if this actually happened to you." Contact is optional on the MTA form: not required for approval; `/name` and `/email` are passed through if set.
- Filing: target `real` (as for every category), `allowedHosts ["contact.mta.info","mta.info","new.mta.info"]`, `payload.form.transit = draft.transit`, `payload.realSubmitAuthorized = ALLOW_REAL_SUBMIT==="1" && approvedVersion===draftVersion`. **ALLOW_REAL_SUBMIT unset ⇒ dry run**: the worker fills everything and stops before "Submit your feedback" ⇒ `HUMAN_ACTION_REQUIRED` with `errorCode null`, rendered as "Dry run: …" with the last screenshot (the browser is closed so the recording can be sent).
- Receipts: SUBMITTED iff reference matches `[A-Z0-9-]{5,}` AND confirmationText AND confirm-step evidence; submit clicked without that ⇒ `SUBMISSION_UNKNOWN` (never retried). OfficialRequest `statusSource: "confirmation"`; `/status <n>` answers from the stored record ("MTA case n, filed …; the MTA replies by email, there is no public status lookup").

## Session recordings (all categories)
After any filing attempt that used Anchor, `filing.ts` polls `GET /v1/sessions/:id/recordings` every 10 s for up to 3 min in the background (never blocks the outcome), downloads `file_link` with the `anchor-api-key` header (only sent to `*.anchorbrowser.io`) to `.runs/<attemptId>/recording.mp4`, registers it as Evidence `recording` (`video/mp4`, served at `/api/evidence/:id`, linked from the dashboard), and calls `executeFiling(..., { onRecording })`; the orchestrator sends it as a Telegram video (`OutboundMessage.videoPath`, ≤ 50 MB else a text note) after the outcome message. Local browser: skipped.

## Ownership (parallel agents — stay in your lane)
- A worker: `apps/worker/**` (the replica portal `apps/portal` was removed: real-only product)
- B core + telegram + api: `apps/bot/src/{index,core/state-machine,core/orchestrator,core/knowledge}.ts`, `apps/bot/src/telegram/**`, `apps/bot/src/api/**`, `apps/bot/src/services/complaints.ts`, `apps/bot/scripts/demo.ts`, `apps/bot/src/integrations/env.ts`
- C intelligence: `apps/bot/src/services/{classifier,location,duplicates,status}.ts`, `apps/bot/src/integrations/{openrouter,nyc-open-data,geosearch}.ts`, `fixtures/**`
- D filing: `apps/bot/src/services/{filing,receipts}.ts`, `apps/bot/src/integrations/{daytona,local-sandbox,anchor,local-browser}.ts`
- E data + observability: `apps/bot/src/integrations/{surrealdb,arize}.ts`, `apps/bot/scripts/{seed,evals}.ts`
- F dashboard: `apps/dashboard/**`
- G MTA wizard: `apps/worker/src/adapters/mta-subway-delay.ts`, `apps/worker/docs/mta-subway-delay-wizard.md`
- H subway-delay in the bot (category-aware knowledge, transit merge, MTA draft card, real-only filing, MTA receipts/status, live MTA alerts, session recordings): `apps/bot/src/core/knowledge.ts` (missingFields/transit helpers), `apps/bot/src/integrations/mta-alerts.ts`, the subway paths in `orchestrator.ts`, `complaints.ts`, `classifier.ts`, `filing.ts`, `receipts.ts`, `messages.ts`, `scripts/demo.ts --scenario subway`, `src/core/subway.test.ts`

Provider resolution lives in `apps/bot/src/integrations/index.ts` (agent B writes it): `getStore()`, `getTracer()`, `getClassifier()`, `getLocationService()`, `getDuplicateService()`, `getSandboxProvider()`, `getBrowserProvider()` — each a lazy singleton calling the factories `createSurrealStore()`, `createTracer()`, `createOpenRouterClassifier()`, `createLocationService()`, `createDuplicateService()`, `createDaytonaSandboxProvider()/createLocalSandboxProvider()`, `createAnchorBrowserProvider()/createLocalBrowserProvider()`. If a factory's file doesn't exist yet when you typecheck, create a minimal stub ONLY if absent with a leading `// STUB — replaced by agent X` comment; never overwrite an existing file.
