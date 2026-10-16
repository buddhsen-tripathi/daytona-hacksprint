# @311relay/portal — NYC311 Demo Portal

Zero-dependency Node 22 replica of the NYC DOT pothole flow (two steps, same shape as the official form) plus a
single-page street-repair form. Used by the filing worker for safe, repeatable demos. **Not the official site.**

```bash
node server.js                      # 0.0.0.0:3311, mode normal
PORT=4000 MODE=flaky node server.js # env: PORT, HOST, MODE, FLAKY_DELAY_MS (default 2000)
node --test tests/portal.test.mjs   # in-process server; or BASE_URL=http://host:port to test a running one
```

Only relative links/redirects are used, so it works behind the Daytona preview proxy.

**Mode**: `?mode=normal|captcha|flaky|reject` on any GET (persisted in cookie `demo_mode` and a hidden `mode`
form field), else env `MODE`. Priority on POST: hidden field > cookie > env.

| Route | |
|---|---|
| `GET /report/pothole` | Step 1 "Customer Information": `first_name`*, `last_name`*, `house_number`, `street_name`, `city`, `state`, `zip`, `email`, `home_phone`, `work_phone`, `date_detected` (MM/DD/YYYY); button `data-testid=next` "Next >>" |
| `POST /report/pothole/step1` | 302 → `/report/pothole/location?draft=<id>` (400 + `form-error` on validation; captcha mode: 400 + `captcha-error`) |
| `GET /report/pothole/location` | Step 2 "Pothole Location": `borough`* (select), `location_type` (radio Street/Intersection), `house_number`, `on_street`*, `cross_street_1`*, `cross_street_2`, `description`*; `data-testid=submit` |
| `POST /report/pothole/submit` | normal → 302 `/confirmation/<sr>`; reject → 200 + `form-error` "We could not locate this street in New York City."; flaky → record saved, socket destroyed after 2 s |
| `GET /report/street-repair` / `POST …/submit` | `borough`*, `on_street`*, `cross_street_1`*, `restoration_type`* (Street cut/Trench/Patch), `description`*, optional contact; same mode behaviour |
| `GET /confirmation/<sr>` | `data-testid=sr-number` (`DEMO-YYYYMMDD-XXXXXX`) + `data-testid=confirmation` |
| `GET /api/status/<sr>` | `{ sr, status, category, createdAt, borough }` or 404 |
| `GET /api/requests` · `POST /api/reset` · `GET /health` | inspect / clear the in-memory store |

Every input has `<label for>`, `name`, `id` and `data-testid` equal to its name (radios: ids
`location_type_street` / `location_type_intersection`). In captcha mode every form also renders a
`div.g-recaptcha[data-sitekey]` "Verify you are human" block.

**Idempotency**: submissions are keyed by the step-1 draft id (pothole) or a hidden `form_token` (street repair).
A replayed POST never creates a second record (normal → same confirmation; flaky → socket dropped again).
This matters: Chrome transparently re-sends a POST once after `ERR_EMPTY_RESPONSE`, which the flaky mode triggers.
