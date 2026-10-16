// HTML rendering for the NYC311 Demo Portal. Zero dependencies.
// Every input has <label for>, name, id and data-testid equal to the name.

export const BOROUGHS = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
export const RESTORATION_TYPES = ["Street cut", "Trench", "Patch"];

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;color:#222;font-size:14px}
.banner{background:#fff3cd;border-bottom:2px solid #e0a800;color:#5c4400;padding:8px 16px;font-weight:bold;text-align:center}
header{background:#3d3d3d;color:#fff;padding:0}
header .top{display:flex;align-items:center;gap:16px;padding:10px 16px;background:linear-gradient(90deg,#1c6e3d,#2e8b57)}
header .logo{background:#fff;color:#1c6e3d;font-weight:900;padding:6px 10px;border-radius:2px;line-height:1.05;font-size:15px}
header .title{font-size:18px;font-weight:bold}header .sub{font-size:12px;opacity:.85}
nav{background:#4a4a4a;padding:6px 16px;font-size:12px}nav a{color:#fff;margin-right:14px;text-decoration:none}
main{max-width:860px;margin:18px auto;background:#fff;border:1px solid #ccc;padding:18px 24px}
h1{color:#1c8f4f;font-size:22px;margin:4px 0 12px}
fieldset{border:2px solid #333;margin:0 0 14px;padding:10px 14px}legend{font-weight:bold;padding:0 6px}
.row{display:flex;align-items:center;margin:6px 0}.row label{width:200px}.row input,.row select,.row textarea{width:320px;padding:4px;border:1px solid #888;font-size:14px}
.row textarea{height:90px}.req{color:#c00;font-weight:bold;margin-right:4px}
.btn{background:#eee;border:2px solid #1a5fb4;border-radius:3px;padding:6px 18px;font-size:14px;cursor:pointer}
.error{background:#fde8e8;border:1px solid #c00;color:#900;padding:8px 12px;margin:0 0 12px}
.note{font-size:12px;color:#444;margin-top:14px}
.captcha{border:1px solid #d3d3d3;background:#f9f9f9;width:304px;padding:14px;margin:10px 0;display:flex;align-items:center;gap:10px;border-radius:3px}
.captcha .box{width:24px;height:24px;border:2px solid #555;background:#fff}
.confirm{border:2px solid #1c8f4f;background:#eefaf2;padding:14px}.sr{font-size:22px;font-weight:bold;font-family:monospace}
footer{text-align:center;font-size:11px;color:#666;padding:12px}
.radio label{width:auto;margin-right:12px}.radio input{width:auto}
`;

export function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — NYC311 Demo Portal</title><style>${CSS}</style></head><body>
<div class="banner" data-testid="demo-banner">NYC311 Demo Portal — controlled replica, not the official site</div>
<header><div class="top"><div class="logo">NEW YORK CITY<br>DOT</div><div><div class="title">New York City Department of Transportation</div><div class="sub">NYC311 Demo Portal · street condition reporting</div></div></div>
<nav><a href="/">Home</a><a href="/report/pothole">Report a Pothole</a><a href="/report/street-repair">Street Repair Complaint</a></nav></header>
<main>${body}</main><footer>Demo replica for automated-filing tests. No report submitted here reaches the City of New York.</footer></body></html>`;
}

function input(name, label, { value = "", required = false, type = "text", placeholder = "" } = {}) {
  return `<div class="row"><label for="${name}">${required ? '<span class="req">**</span>' : ""}${esc(label)}:</label>` +
    `<input type="${type}" id="${name}" name="${name}" data-testid="${name}" value="${esc(value)}"${required ? " required" : ""}${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}></div>`;
}

function select(name, label, options, { value = "", required = false } = {}) {
  const opts = [`<option value="">-- Select --</option>`]
    .concat(options.map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`))
    .join("");
  return `<div class="row"><label for="${name}">${required ? '<span class="req">**</span>' : ""}${esc(label)}:</label>` +
    `<select id="${name}" name="${name}" data-testid="${name}"${required ? " required" : ""}>${opts}</select></div>`;
}

function textarea(name, label, { value = "", required = false } = {}) {
  return `<div class="row"><label for="${name}">${required ? '<span class="req">**</span>' : ""}${esc(label)}:</label>` +
    `<textarea id="${name}" name="${name}" data-testid="${name}"${required ? " required" : ""}>${esc(value)}</textarea></div>`;
}

function hidden(name, value) {
  return `<input type="hidden" id="${name}" name="${name}" data-testid="${name}" value="${esc(value)}">`;
}

function errorBlock(error, testid = "form-error") {
  return error ? `<div class="error" role="alert" data-testid="${testid}">${esc(error)}</div>` : "";
}

export function captchaBlock() {
  return `<div class="g-recaptcha captcha" data-sitekey="demo-sitekey-6LdDEMO000000000000000000000" data-testid="captcha">
<div class="box"></div><div><strong>Verify you are human</strong><br><small>I'm not a robot · reCAPTCHA (demo)</small></div></div>`;
}

export function landingPage(mode) {
  return layout("Home", `<h1>NYC311 Demo Portal</h1>
<p>This is a controlled replica of the NYC DOT pothole and street-repair reporting flow, used for safe, repeatable automated-filing demos.</p>
<ul><li><a href="/report/pothole" data-testid="link-pothole">Report a Pothole</a> (two steps, mirrors the official DOT form)</li>
<li><a href="/report/street-repair" data-testid="link-street-repair">Street Repair Complaint</a></li></ul>
<p class="note">Current mode: <code data-testid="mode">${esc(mode)}</code>. Switch with <code>?mode=normal|captcha|flaky|reject</code>.</p>`);
}

export function step1Page({ mode, values = {}, error = null, captchaError = null }) {
  const v = values;
  return layout("Report a Pothole", `<h1>Report a Pothole</h1>
${errorBlock(error)}${errorBlock(captchaError, "captcha-error")}
<form method="post" action="/report/pothole/step1" data-testid="step1-form">
${hidden("mode", mode)}
<fieldset><legend>Customer Information</legend>
${input("first_name", "First Name", { value: v.first_name, required: true })}
${input("last_name", "Last Name", { value: v.last_name, required: true })}
${input("house_number", "House Number", { value: v.house_number })}
${input("street_name", "Street Name", { value: v.street_name })}
${input("city", "City", { value: v.city })}
${input("state", "State", { value: v.state })}
${input("zip", "Zip Code", { value: v.zip })}
${input("email", "Email", { value: v.email, type: "email" })}
${input("home_phone", "Home Phone", { value: v.home_phone, type: "tel" })}
${input("work_phone", "Work Phone", { value: v.work_phone, type: "tel" })}
</fieldset>
<fieldset>${input("date_detected", "Date Detected", { value: v.date_detected, placeholder: "MM/DD/YYYY" })}</fieldset>
${mode === "captcha" ? captchaBlock() : ""}
<input type="submit" class="btn" id="next" name="next" data-testid="next" value="Next &gt;&gt;">
</form>
<p class="note">** Denote required field · Date format: "MM/DD/YYYY" · Email format: defect@server.com</p>
<p class="note"><strong>Note:</strong> This form cannot process complaints concerning locations on highways or parkways. Potholes are characterized by a definable bottom surface such as dirt or gravel.</p>`);
}

export function step2Page({ mode, draftId, values = {}, error = null, captchaError = null }) {
  const v = values;
  const lt = v.location_type === "Intersection" ? "Intersection" : "Street";
  return layout("Pothole Location", `<h1>Report a Pothole</h1>
${errorBlock(error)}${errorBlock(captchaError, "captcha-error")}
<form method="post" action="/report/pothole/submit" data-testid="step2-form">
${hidden("mode", mode)}${hidden("draft", draftId)}
<fieldset><legend>Pothole Location</legend>
${select("borough", "Borough", BOROUGHS, { value: v.borough, required: true })}
<div class="row radio"><span style="width:200px">Location Type:</span>
<input type="radio" id="location_type_street" name="location_type" data-testid="location_type" value="Street"${lt === "Street" ? " checked" : ""}><label for="location_type_street">Street</label>
<input type="radio" id="location_type_intersection" name="location_type" data-testid="location_type" value="Intersection"${lt === "Intersection" ? " checked" : ""}><label for="location_type_intersection">Intersection</label></div>
${input("house_number", "House Number", { value: v.house_number })}
${input("on_street", "On Street", { value: v.on_street, required: true })}
${input("cross_street_1", "Cross Street 1", { value: v.cross_street_1, required: true })}
${input("cross_street_2", "Cross Street 2", { value: v.cross_street_2 })}
${textarea("description", "Additional details", { value: v.description, required: true })}
</fieldset>
${mode === "captcha" ? captchaBlock() : ""}
<input type="submit" class="btn" id="submit" name="submit" data-testid="submit" value="Submit">
</form>`);
}

export function streetRepairPage({ mode, formToken = "", values = {}, error = null, captchaError = null }) {
  const v = values;
  return layout("Street Repair Complaint", `<h1>Street Repair Complaint</h1>
<p>Report a defect inside a previously repaired area: a street cut, trench or patch that is raised, sunken or has developed a pothole.</p>
${errorBlock(error)}${errorBlock(captchaError, "captcha-error")}
<form method="post" action="/report/street-repair/submit" data-testid="street-repair-form">
${hidden("mode", mode)}${hidden("form_token", formToken)}
<fieldset><legend>Location</legend>
${select("borough", "Borough", BOROUGHS, { value: v.borough, required: true })}
${input("on_street", "On Street", { value: v.on_street, required: true })}
${input("cross_street_1", "Cross Street 1", { value: v.cross_street_1, required: true })}
</fieldset>
<fieldset><legend>Problem</legend>
${select("restoration_type", "Restoration Type", RESTORATION_TYPES, { value: v.restoration_type, required: true })}
${textarea("description", "Additional details", { value: v.description, required: true })}
</fieldset>
<fieldset><legend>Contact (optional)</legend>
${input("first_name", "First Name", { value: v.first_name })}
${input("last_name", "Last Name", { value: v.last_name })}
${input("email", "Email", { value: v.email, type: "email" })}
${input("home_phone", "Phone", { value: v.home_phone, type: "tel" })}
</fieldset>
${mode === "captcha" ? captchaBlock() : ""}
<input type="submit" class="btn" id="submit" name="submit" data-testid="submit" value="Submit">
</form>`);
}

export function confirmationPage(rec) {
  const what = rec.category === "street-repair" ? "street repair complaint" : "pothole report";
  return layout("Confirmation", `<h1>Thank you</h1>
<div class="confirm"><p>Service Request Number: <span class="sr" data-testid="sr-number">${esc(rec.sr)}</span></p>
<p data-testid="confirmation">Your ${what} has been submitted. Please keep this number for your records.</p>
<p class="note">Borough: ${esc(rec.borough)} · On street: ${esc(rec.on_street)} · Submitted ${esc(rec.createdAt)}</p></div>
<p class="note">Check status: <a href="/api/status/${encodeURIComponent(rec.sr)}" data-testid="status-link">/api/status/${esc(rec.sr)}</a></p>`);
}

export function notFoundPage() {
  return layout("Not found", `<h1>Page not found</h1><p><a href="/">Return home</a></p>`);
}
