# MTA Customer Feedback wizard: subway delay path

Target: https://contact.mta.info/s/customer-feedback (Salesforce Experience Cloud page with a Skuid wizard).
Mapped 2026-10-16 with headless Chrome (Playwright), stopping before the final click. Adapter: `src/adapters/mta-subway-delay.ts`.

- **No CAPTCHA** (no reCAPTCHA, hCaptcha, Turnstile or `[data-sitekey]` on any step) and **no login wall**. The header has a "Log in" link, but it is optional.
- **No review step.** The last page is "Contact details" and it holds the final button.
- **Final submit button:** `Submit your feedback` (a `button` with `aria-label="Submit your feedback"`).
- **Contact details are all optional:** First name (optional), Last name (optional), Email (optional). The form has **no phone field**.
- Everything stays on one URL (`/s/customer-feedback`). Main-frame navigations only went to `contact.mta.info`. Subresources load from `cdn.skuid.net`, `cdn.weglot.com`, `api.weglot.com`, `www.googletagmanager.com`, `www.google-analytics.com`, `api.ipify.org`, `static.cloudflareinsights.com` and `fonts.googleapis.com`. The guard only checks top-level navigations, so these load fine.
- Choice buttons have **no inner text**, only an `aria-label`. `getByRole("button", { name })` works. `Continue` stays **disabled** until a choice is made; the adapter waits for it to become enabled. The stepper buttons `1..4` are always disabled.

## Steps

| # | Stepper | Question / heading | Controls | Required? | Adapter |
|---|---|---|---|---|---|
| 0 | – | Landing | `Get started` | – | click |
| 1 | Start | Which service? | Buttons: Subways, Buses, Long Island Rail Road, Metro-North Railroad, Access-A-Ride (Paratransit), Bridges, Tunnels, and Congestion Relief Zone, MTA website, mobile app, and 511, Other MTA agencies and departments → Continue | yes | **Subways** (fixed) |
| 2 | Topic | I have a… | Complaint or issue / Compliment / Request / Suggestion → Continue | yes | **Complaint or issue** (fixed) |
| 3 | Topic | Related to… | At a station / On a train / Service and schedule / Fares, OMNY, and Tap and ride / Accessibility, elevators, and escalators / Something else → Continue | yes | **Service and schedule** (fixed) |
| 4 | Topic | About… | Delay / Planned service change / Scheduled stop missed / skipped / Early departure / Rerouting / Schedules and service planning / Something else → Continue | yes | **Delay** (fixed) |
| 5 | Details | Select the line | 26 buttons `"<line> Line"`: 1–7, A C E B D F M N Q R W G L J Z, S-42 Street Shuttle, S-Franklin Av Shuttle, S-Rockaway Park Shuttle, Staten Island Railway | yes | `transit.line` → `"<line> Line"` |
| 6 | Details | Which direction? (breadcrumb `Details: A`) | 2 buttons per line (table below) | effectively yes | `transit.direction`, fuzzy match |
| 7 | Details | Which station was nearest (if known)? | Borough filter cards (plain text divs, e.g. Queens / Manhattan / Brooklyn, depending on the line; they can render late) + a Skuid picklist button showing `- - - -` (label `Step9Id`) that opens a `role=listbox` of the line's stations (`role=option`) | **optional** (Continue enabled with nothing chosen) | `transit.station` (+ `transit.borough` to break ties); skipped if no unique match |
| 8 | Details | Additional Information | text input `Car number` (optional, has an info tooltip) | optional | left blank |
| 9 | Details | **Tell us more (Required)** + When did this happen? | `textarea` (placeholder "Please provide more details about your feedback", counter **0/4000**, no `maxlength` attribute); `Now` button; date input placeholder `M/D/YYYY` (opens a calendar); 3 picklists: hour `12,1..11`, minute `00..59`, `am/pm` (default 8:00 am, date empty) | textarea **yes**; date/time optional (Continue enables once the textarea has text) | `description` (≤4000); `transit.incidentTime` → New York local date/hour/minute/am-pm |
| 10 | Submit | Contact details: "Enter your contact information if you'd like us to follow up about your feedback." | First name (optional), Last name (optional), Email (optional); checkbox "Sign up to receive news and updates from the MTA" (unchecked); file upload "Do you have a picture or file to upload?" (PDF/JPG/PNG/video/audio, max 14 MB); **`Submit your feedback`** | all optional | `contactName` (split first/rest), `contactEmail`. Newsletter box and upload are never touched. **Final click only if `realSubmitAuthorized === true`.** |

The `Details:` breadcrumb gathers the choices, e.g. `Details: A / Downtown & Queens / 14 St`. Validation checks it.

## Direction options per line (aria-labels)

| Line | Option 1 | Option 2 |
|---|---|---|
| 1 | 1 Train-Downtown (South Ferry) | 1 Train-Uptown & The Bronx |
| 2 | 2 Train-Downtown & Brooklyn | 2 Train-Uptown & The Bronx |
| 3 | 3 Train-Downtown & Brooklyn | 3 Train-Uptown (Harlem-148 St) |
| 4 | 4 Train-Uptown & The Bronx | 4 Train-Downtown & Brooklyn |
| 5 | 5 Train-Uptown & The Bronx | 5 Train-Downtown & Brooklyn |
| 6 | 6 Train-Uptown & The Bronx | 6 Train-Downtown (Brooklyn Bridge-City Hall) |
| 7 | 7 Train-Queens (Flushing-Main St) | 7 Train-Manhattan (34 St-Hudson Yards) |
| A | A Train-Uptown (Inwood-207 St) | A Train-Downtown & Queens |
| C | C Train-Downtown & Brooklyn | C Train-Uptown (168 St) |
| E | E Train-Downtown (World Trade Ctr) | E Train-Uptown & Queens |
| B | B Train-Downtown & Brooklyn | B Train-Uptown & The Bronx |
| D | D Train-Downtown & Brooklyn | D Train-Uptown & The Bronx |
| F | F Train-Downtown & Brooklyn | F Train-Uptown & Queens |
| M | M Train-Uptown & Forest Hills-71 Av | M Train-Downtown & Middle Village-Metropolitan Av |
| N | N Train-Downtown & Brooklyn | N Train-Uptown & Queens |
| Q | Q Train-Downtown & Brooklyn | Q Train-Uptown (96 St) |
| R | R Train-Downtown & Brooklyn | R Train-Uptown & Queens |
| W | W Train-Whitehall St-South Ferry | W Train-Astoria-Ditmars Blvd |
| G | G Train-Brooklyn (Church Av) | G Train-Queens (Court Sq) |
| L | L Train-Brooklyn (Canarsie-Rockaway Pkwy) | L Train-Manhattan (8 Av) |
| J | J Train-Queens (Jamaica Ctr-Parsons/Archer) | J Train-Manhattan (Broad St) |
| Z | Z Train-Broad St | Z Train-Jamaica Ctr-Parsons/Archer |
| S-42 Street Shuttle | S-42 Street Shuttle-Times Sq-42 St | S-42 Street Shuttle-Grand Central-42 St |
| S-Franklin Av Shuttle | S-Franklin Av Shuttle-Franklin Av | S-Franklin Av Shuttle-Prospect Park |
| S-Rockaway Park Shuttle | S-Rockaway Park Shuttle-Rockaway Park-Beach 116 St | S-Rockaway Park Shuttle-Broad Channel |
| Staten Island Railway | Staten Island Railway-Tottenville | Staten Island Railway-St. George |

How matching works (`matchDirection`): the label prefix is stripped, then both sides are tokenized with synonyms (northbound/north→uptown, southbound/south→downtown, "-bound" dropped, "city"→manhattan, ordinals dropped: 207th→207). The option with the single best token overlap wins. Zero overlap or a tie gives `HUMAN_ACTION_REQUIRED/UNEXPECTED_REQUIRED_FIELD`, and the message lists both options, e.g. *Which direction was the A train going? The MTA form offers: "Uptown (Inwood-207 St)" or "Downtown & Queens" ("Brooklyn-bound" does not clearly match one of them).* `data.options` / `data.optionsShort` carry the labels for the bot.

## Stations

The station picker lists every station on the chosen line, in route order (A: Rockaway Park … Inwood-207 St, 68 options). Clicking a borough card filters the list (F + "Manhattan" leaves 13 stations). Matching (`stationCandidates`) normalizes street→st, avenue→av, square→sq, 14th→14, and so on. An exact match wins, then a unique whole-word contains match. If the name appears twice on a line and a borough is given, the adapter clicks that borough card and matches again. Anything still not unique is skipped (the field is optional) and logged in `skipped`.

## Confirmation (not observed: no real submission was made while mapping)

After the click, `confirm()` waits up to max(30 s, 2×stepTimeout) for "thank you / received / case|reference|confirmation number" text, or for the `Submit your feedback` button to disappear. It then captures text, a screenshot and the HTML. `parseReference()`:
1. `(case|reference|confirmation|ticket|tracking|request) (number|#|no.|id)? (is)? [:#]? TOKEN`, where TOKEN `[A-Z0-9][A-Z0-9-]{4,}` **must contain a digit** (so "confirmation email" is not read as a number);
2. otherwise a standalone `\d{8,}` within about 600 chars of "thank you / received".
Possible results: a number gives `officialRequestNumber` + `confirmationText`. A thank-you message with no number gives `officialRequestNumber=null` + `confirmationText`, which becomes SUBMISSION_UNKNOWN with evidence. If the submit button is still there and no thank-you text appears, the result is SUBMISSION_UNKNOWN/NO_CONFIRMATION. A number is never invented. Salesforce case numbers are usually 8-digit zero-padded (e.g. `01234567`); the bot's `CATEGORY_SR_PATTERNS["subway-delay"] = /^[A-Z0-9-]{5,}$/i` accepts that.

## Screenshots (`docs/mta/`)

01-landing, 02-service, 03-i-have-a, 04-related-to, 05-about, 06-line, 07-direction, 08-station-picker, 09-additional-info, 10-tell-us-more (filled), 11-contact-submit (filled final page, before Submit).
