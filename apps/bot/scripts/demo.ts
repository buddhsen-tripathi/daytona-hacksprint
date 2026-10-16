/**
 * Drive the 311Relay conversation without Telegram.
 *
 *   pnpm --filter @311relay/bot demo -- --scenario happy [--no-filing]
 *
 * Scenarios: happy | missing-location | duplicate | cancel | emergency | out-of-scope | ambiguous | subway | subway-ambiguous
 *   happy: street pothole → the official DOT form. The worker fills the resident's fields (name set via /name) and
 *           stops at the reCAPTCHA ⇒ HUMAN_ACTION_REQUIRED/CAPTCHA hand-off (Anchor live view). Read-only: never submits.
 *   subway: a genuine A-train delay → MTA Customer Feedback (real-only). ALLOW_REAL_SUBMIT unset ⇒ dry run
 *           (the worker fills the form and stops before Submit). Prints the exact FilingPayload preview.
 *   subway-ambiguous: "A train delayed, Manhattan-bound" — the direction is left for the worker, which pauses on the
 *           MTA direction step and asks live (browser.ask_resident). The fake resident taps option --answer (default 1,
 *           0-based) after 2 s; the worker continues in the same browser to the dry-run stop.
 * Uses STORE_BACKEND=memory unless you set STORE_BACKEND yourself.
 */
process.env.STORE_BACKEND ??= "memory";

const { resolve } = await import("node:path");
const { createOrchestrator } = await import("../src/core/orchestrator.js");
const { resolveProviders, providerReport } = await import("../src/integrations/index.js");
const { createCaptureTransport, resolveFixture, FIXTURE_IMAGES } = await import("../src/api/capture-transport.js");
const { stripHtml } = await import("../src/telegram/messages.js");
const { previewPayload } = await import("../src/services/filing.js");
type InboundEvent = import("../src/core/contracts.js").InboundEvent;
type CapturedMessage = import("../src/api/capture-transport.js").CapturedMessage;

const argv = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1]!;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split("=")[1]! : fallback;
};
const SCENARIOS = ["happy", "missing-location", "duplicate", "cancel", "emergency", "out-of-scope", "ambiguous", "subway", "subway-ambiguous"] as const;
type Scenario = (typeof SCENARIOS)[number];
const scenario = opt("scenario", "happy") as Scenario;
if (!SCENARIOS.includes(scenario)) {
  console.error(`Unknown scenario "${scenario}". Use one of: ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const noFiling = flag("no-filing");

const C = { dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };

// --chat <id> pins the resident (SurrealDB memory: "you reported … ago"). The subway scenario uses one stable rider by default.
const chatId = opt("chat", scenario === "subway" ? "demo-subway-rider" : `demo-${scenario}-${Date.now().toString(36)}`);
let seq = 0;
const base = () => ({ chatId, updateId: `demo-${++seq}-${Date.now()}`, username: "demo_user" });

const answerIndex = Number(opt("answer", "1"));
const answered: string[] = [];
const transport = createCaptureTransport({
  // Fake resident: answer live worker questions after 2 s (handle() answers outside the per-chat queue).
  onQuestion: (q) => {
    const choice = q.options[answerIndex] ?? q.options[0];
    setTimeout(() => {
      if (choice) {
        answered.push(choice.text);
        void tap(choice.data);
      } else void say("skip");
    }, 2000);
  },
  onSend: (m) => {
    if (m.editMessageId) {
      console.log(`${C.dim}       ${stripHtml(m.text).split("\n").pop()}${C.reset}`);
      return;
    }
    console.log(`\n${C.cyan}${C.bold}bot ▸${C.reset} ${stripHtml(m.text).replace(/\n/g, "\n       ")}`);
    if (m.photoPath) console.log(`${C.dim}       [photo attached: ${m.photoPath}]${C.reset}`);
    if (m.videoPath) console.log(`${C.dim}       [video attached: ${m.videoPath}]${C.reset}`);
    if (m.requestLocation) console.log(`${C.dim}       [keyboard: 📍 Share location]${C.reset}`);
    for (const row of m.buttons ?? []) console.log(`${C.dim}       ${row.map((b) => `[${b.text}${b.url ? ` → ${b.url}` : ""}]`).join(" ")}${C.reset}`);
  },
});

const providers = await resolveProviders();
let lastOutcome: unknown = null;
const filing = {
  async executeFiling(...args: Parameters<typeof providers.filing.executeFiling>) {
    const outcome = await providers.filing.executeFiling(...args);
    lastOutcome = outcome;
    return outcome;
  },
};
const orchestrator = createOrchestrator({ ...providers, filing, transport, ...(scenario === "subway-ambiguous" ? { directionDuringFiling: true } : {}) });

console.log(`${C.bold}311Relay demo — scenario: ${scenario}${noFiling ? " (no filing)" : ""}${C.reset}`);
console.log(C.dim + Object.entries(providerReport()).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join("\n") + C.reset);

function describe(e: InboundEvent) {
  switch (e.kind) {
    case "command":
      return `/${e.command}${e.args ? ` ${e.args}` : ""}`;
    case "text":
      return e.text;
    case "photo":
      return `[photo ${e.fileId}]${e.caption ? ` “${e.caption}”` : ""}`;
    case "location":
      return `[📍 ${e.latitude}, ${e.longitude}]`;
    case "callback":
      return `[tap ${e.data.split(":")[0]}]`;
    default:
      return `[${e.kind}]`;
  }
}

async function user(e: InboundEvent) {
  console.log(`\n${C.green}${C.bold}you ▸${C.reset} ${describe(e)}`);
  const before = transport.messages.length;
  await orchestrator.handle(e, { waitForFiling: true });
  return transport.messages.slice(before);
}
const say = (text: string) => user({ ...base(), kind: "text", text });
const cmd = (command: string, args = "") => user({ ...base(), kind: "command", command, args });
const pin = (latitude: number, longitude: number) => user({ ...base(), kind: "location", latitude, longitude });
const photo = (name: string, caption: string | null = null) => user({ ...base(), kind: "photo", fileId: `fixture:${name}`, caption });

function findButton(msgs: CapturedMessage[], action: string): string | null {
  for (const m of [...msgs].reverse()) for (const row of m.buttons ?? []) for (const b of row) if (b.data?.startsWith(`${action}:`)) return b.data;
  return null;
}
const tap = (data: string) => user({ ...base(), kind: "callback", data, messageId: null });

const hasPhoto = !!resolveFixture("fixture:pothole-1");
if (!hasPhoto) console.log(`${C.yellow}(no ${resolve(FIXTURE_IMAGES, "pothole-1.jpg")} yet, using text only)${C.reset}`);

/** Street categories: the official DOT form requires the resident's first + last name (gated before approval). */
const STREET_NAME = opt("name", "Ada Lovelace");

async function intake(opts: { withLocation: boolean }) {
  let msgs: CapturedMessage[] = await cmd("name", STREET_NAME);
  if (hasPhoto) msgs = await photo("pothole-1");
  msgs = await say("This road is completely broken");
  if (opts.withLocation) msgs = await pin(40.758, -73.9855);
  return msgs;
}

/** From the latest bot messages, continue past duplicate review and (optionally) approve. */
async function reviewAndApprove(msgs: CapturedMessage[]) {
  const dup = findButton(msgs, "dup_continue");
  if (dup) msgs = await tap(dup);
  const approve = findButton(msgs, "approve");
  if (!approve) {
    console.log(`\n${C.yellow}No approve button offered; stopping.${C.reset}`);
    return;
  }
  if (noFiling) {
    console.log(`\n${C.yellow}--no-filing: stopping at READY_FOR_APPROVAL.${C.reset}`);
    return;
  }
  await tap(approve);
  await orchestrator.idle();
}

await cmd("start");
switch (scenario) {
  case "happy":
  case "duplicate": {
    const msgs = await intake({ withLocation: true });
    if (scenario === "duplicate" && !findButton(msgs, "dup_continue")) console.log(`\n${C.yellow}(no duplicates returned by Open Data for this location right now)${C.reset}`);
    await reviewAndApprove(msgs);
    break;
  }
  case "missing-location": {
    await intake({ withLocation: false });
    const msgs = await say("W 42nd St & 7th Ave, Manhattan");
    const next = findButton(msgs, "approve") || findButton(msgs, "dup_continue") ? msgs : await pin(40.758, -73.9855);
    await reviewAndApprove(next);
    break;
  }
  case "cancel": {
    let msgs = await intake({ withLocation: true });
    const dup = findButton(msgs, "dup_continue");
    if (dup) msgs = await tap(dup);
    const cancel = findButton(msgs, "cancel");
    if (cancel) await tap(cancel);
    else await cmd("cancel");
    break;
  }
  case "emergency":
    await say("There's a huge open hole in the road on my block, a car fell in and someone is hurt");
    break;
  case "out-of-scope":
    await say("My neighbor's dog keeps barking all night");
    break;
  case "subway": {
    await cmd("report"); // start fresh (a previous run's open draft stays in memory as "you reported …")
    let msgs = await say("The A train sat at 14 St for 25 minutes this morning around 8:30, downtown, no announcements");
    for (let i = 0; i < 4 && !findButton(msgs, "approve"); i++) {
      const last = stripHtml(msgs[msgs.length - 1]?.text ?? "");
      const dir = findButton(msgs, "set_direction");
      const time = findButton(msgs, "set_time");
      if (/which line/i.test(last)) msgs = await say("The A train");
      else if (dir) msgs = await say("Downtown");
      else if (/which direction/i.test(last)) msgs = await say("Downtown");
      else if (time) msgs = await tap(`${time.split(":").slice(0, 3).join(":")}:now`);
      else break;
    }
    const asked = transport.messages.some((m) => m.requestLocation || /share the location|nearest intersection/i.test(m.text));
    console.log(`\n${C.bold}Location asked:${C.reset} ${asked ? "YES (bug)" : "no"}`);
    const d = (await providers.store.listComplaints({ chatId, limit: 1 }))[0];
    if (d) {
      const resident = await providers.store.getOrCreateResident(chatId, "demo_user");
      const approvedVersion = d.status === "READY_FOR_APPROVAL" ? d.draftVersion : d.approvedVersion;
      console.log(`\n${C.bold}FilingPayload preview (per-attempt fields attemptId/cdpUrl/liveViewUrl/extraHeaders are added at filing time):${C.reset}\n${JSON.stringify(previewPayload({ ...d, approvedVersion }, resident), null, 2)}`);
    }
    await reviewAndApprove(msgs);
    break;
  }
  case "subway-ambiguous": {
    let msgs = await say("A train delayed, Manhattan-bound");
    for (let i = 0; i < 4 && !findButton(msgs, "approve"); i++) {
      const last = stripHtml(msgs[msgs.length - 1]?.text ?? "");
      const time = findButton(msgs, "set_time");
      if (/which line/i.test(last)) msgs = await say("The A train");
      else if (time) msgs = await tap(`${time.split(":").slice(0, 3).join(":")}:now`);
      else break;
    }
    await reviewAndApprove(msgs);
    const d = (await providers.store.listComplaints({ chatId, limit: 1 }))[0];
    const att = d ? (await providers.store.listAttempts({ complaintId: d.id }))[0] : null;
    const evs = att?.workerEvents ?? [];
    const q = evs.find((e) => e.message === "question");
    const chosen = evs.find((e) => /direction chosen by the resident/.test(e.message));
    const finalShot = [...(att?.evidence ?? [])].reverse().find((e) => e.type === "screenshot");
    console.log(`\n${C.bold}Live question asked by the worker:${C.reset} ${q ? JSON.stringify((q.data as { question?: unknown })?.question) : "NO"}`);
    console.log(`${C.bold}Fake resident tapped:${C.reset} ${answered.join(", ") || "-"}`);
    console.log(`${C.bold}Worker:${C.reset} ${chosen?.message ?? "no resident-chosen direction"}`);
    console.log(`${C.bold}Final screenshot:${C.reset} ${finalShot ? `${finalShot.summary} (${finalShot.storageReference})` : "-"}`);
    break;
  }
  case "ambiguous": {
    await cmd("name", STREET_NAME);
    await say("something's wrong outside my building");
    await say("I think the road is damaged, maybe a pothole");
    let msgs = await pin(40.758, -73.9855);
    if (!findButton(msgs, "approve") && !findButton(msgs, "dup_continue")) msgs = await say("It's a shallow pothole, about a foot wide. Nobody is hurt.");
    await reviewAndApprove(msgs);
    break;
  }
}

await cmd("myreports");
if (!noFiling && (await providers.store.listComplaints({ chatId, limit: 1 }))[0]?.officialRequestNumber) await cmd("status");

const last = (await providers.store.listComplaints({ chatId, limit: 1 }))[0];
if (last) {
  console.log(`\n${C.bold}Final complaint state:${C.reset} ${last.status}${last.statusReason ? ` (${last.statusReason})` : ""}  v${last.draftVersion}  category=${last.category ?? "-"}`);
  if (last.officialRequestNumber) console.log(`${C.bold}Service request:${C.reset} ${last.officialRequestNumber}`);
  const attempts = await providers.store.listAttempts({ complaintId: last.id });
  if (attempts[0]) console.log(`${C.bold}Filing attempt:${C.reset} ${attempts[0].id} outcome=${attempts[0].outcome} error=${attempts[0].errorCode ?? "-"} evidence=${attempts[0].evidence.length}`);
}
await (providers.filing as { drain?: () => Promise<void> }).drain?.().catch(() => {});
if (lastOutcome) console.log(`\n${C.bold}FilingOutcome:${C.reset}\n${JSON.stringify(lastOutcome, null, 2)}`);
await providers.tracer.flush().catch(() => {});
process.exit(0);
