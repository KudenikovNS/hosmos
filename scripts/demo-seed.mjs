// =============================================================================
// scripts/demo-seed.mjs — the DEMO/SHOWCASE seeder.
//
// WHAT IT IS FOR. It puts a deployed instance into a state somebody can be
// SHOWN: log in, click through, and see the whole Phase-1 story end to end —
// organisation → period → data entry → evidence → review → approval → lock →
// calculation → report — plus a company whose six memberships make "разделение
// доступа" a thing you can watch rather than a thing you are told about.
//
// WHY IT IS `.mjs` AND NOT `.ts`. The deploy ships a standalone bundle with
// neither `tsx` nor `src/server/db/seed.ts` in it; the only script that survives
// the trip is `scripts/migrate.mjs`, and it survives because it is plain ESM
// over `node_modules/postgres`. This file follows the same shape for the same
// reason — so that the very thing verified locally is the thing that can be run
// on the server.
//
// WHY IT SPEAKS HTTP AND NOT SQL. The point of a demo seed is that what the
// demo-er clicks is what the product itself produces. Every row here is written
// through the product's own `/api/*` routes, under a real session of a real
// account, so every guard, every parser, every append-only version, every DQ
// pre-fill and every audit row is exactly the one a user would have produced.
//
// THE ONE EXCEPTION, and it is a deliberate one. A membership WITH A ROLE cannot
// be completed over HTTP: `POST /api/invitations` stores only the sha256 of the
// token and mails the raw one, and `POST /api/invitations/accept` needs that raw
// token from an inbox this script does not have. So `company_members` rows — and
// nothing else — are written with SQL, through the same `postgres` client
// `migrate.mjs` uses. `profiles.company_id`/`active_company_id` are deliberately
// NOT written: `resolveActiveMembership` self-heals a stale pointer on the first
// `getSession()`, so writing them here would only duplicate a rule that lives in
// the app.
//
// IDEMPOTENCY. Running it twice must not duplicate anything and must not fail.
// Every create is a find-or-create against the product's own list endpoint, and
// every transition is driven from the revision's CURRENT status, so a second run
// finds everything in place and writes nothing.
//
// CREDENTIALS NEVER LAND IN A COMMITTED FILE. The ten production accounts are
// read at runtime from `workbook/tasks/PROD-USERS.md` (gitignored). The six
// showcase role accounts take their password from `DEMO_ROLE_PASSWORD`, or —
// when that is unset — from a generated `DEMO-USERS.local.md` written beside it,
// inside the same gitignored directory, and read back on every later run.
//
// USAGE
//   DATABASE_URL=postgres://…  BASE_URL=http://localhost:3000  node scripts/demo-seed.mjs
//
// The app must be RUNNING and pointed at the same DATABASE_URL (step 1 refuses
// to go on otherwise), and `DOCUMENTS_DIR` must be set in the APP's environment
// — evidence uploads and renders are files on disk, and there is no fallback.
//
// ENV
//   DATABASE_URL          required. The database the RUNNING APP is also using.
//   BASE_URL              default http://localhost:3000. The app's own PUBLIC
//                         origin — it is sent as `Origin`, so it must be the
//                         host the app answers on (https://hosmos.eu in prod).
//   PROD_USERS_FILE       default <repo>/workbook/tasks/PROD-USERS.md
//   DEMO_ROLE_PASSWORD    password for the six showcase accounts (optional).
//   DEMO_CREDENTIALS_FILE where a generated role password is kept (optional).
//   SKIP_PROD_USERS=1     do not create the ten production accounts.
// =============================================================================
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ─── configuration ───────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const PROD_USERS_FILE =
  process.env.PROD_USERS_FILE ||
  join(repoRoot, "workbook", "tasks", "PROD-USERS.md");
const DEMO_CREDENTIALS_FILE =
  process.env.DEMO_CREDENTIALS_FILE ||
  join(dirname(PROD_USERS_FILE), "DEMO-USERS.local.md");
const SKIP_PROD_USERS = process.env.SKIP_PROD_USERS === "1";

if (!DATABASE_URL) {
  console.error("demo-seed: DATABASE_URL is not set.");
  process.exit(1);
}

// ─── tiny reporting helpers ──────────────────────────────────────────────────

/** What happened, so the closing summary can say "created" vs "already there". */
const tally = { created: [], existing: [] };
/** Things the demo-er must know about but which are not this script's to fix. */
const advisories = [];
let currentStep = "startup";

function step(name) {
  currentStep = name;
  console.log(`\n── ${name}`);
}
function note(message) {
  console.log(`   ${message}`);
}
function made(kind, label) {
  tally.created.push(`${kind}: ${label}`);
  console.log(`   + ${kind} ${label}`);
}
function found(kind, label) {
  tally.existing.push(`${kind}: ${label}`);
  console.log(`   = ${kind} ${label} (already there)`);
}

class SeedError extends Error {}

/** Fail loudly and stop: a half-seeded demo that looks complete is worse. */
function fail(message) {
  throw new SeedError(message);
}

// ─── HTTP: one cookie jar per demo account ───────────────────────────────────

/**
 * A logged-in browser, minus the browser.
 *
 * `Origin: <BASE_URL>` IS SENT ON EVERY REQUEST, and it has to be. better-auth
 * refuses a sign-up/sign-in that carries no Origin at all
 * (`MISSING_OR_NULL_ORIGIN`), so omitting it is not an option; and because every
 * request goes to BASE_URL itself, the header is by construction SAME-ORIGIN —
 * which is the first branch of `requireTrustedOrigin` and of better-auth's own
 * check, so no allowlist has to contain it. The one thing that matters is that
 * BASE_URL is the origin the app is actually served on.
 *
 * Cookies are replayed verbatim rather than by name: better-auth emits the
 * `__Secure-` prefixed variant over HTTPS, so hard-coding `better-auth.session_token`
 * would work locally and silently lose the session in production.
 */
class Session {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(response) {
    const raw =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const line of raw) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** Raw call. Returns `{status, body}`; never throws on a non-2xx. */
  async call(method, path, { json, body, headers } = {}) {
    const h = {
      accept: "application/json",
      origin: BASE_URL,
      ...(headers || {}),
    };
    const cookie = this.cookieHeader();
    if (cookie) h.cookie = cookie;
    let payload = body;
    if (json !== undefined) {
      h["content-type"] = "application/json";
      payload = Buffer.from(JSON.stringify(json));
    }
    if (payload !== undefined) h["content-length"] = String(payload.byteLength);

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: h,
      body: payload,
      redirect: "manual",
    });
    this.absorb(response);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 400) };
    }
    return { status: response.status, body: parsed };
  }

  /** Call and insist on `{ok:true}` — the shape every `/api/*` route returns. */
  async api(method, path, json) {
    const res = await this.call(
      method,
      path,
      json === undefined ? {} : { json },
    );
    if (res.status !== 200 || !res.body || res.body.ok !== true) {
      fail(
        `${this.label}: ${method} ${path} → ${res.status} ` +
          JSON.stringify(res.body),
      );
    }
    return res.body.data;
  }

  get(path) {
    return this.api("GET", path);
  }
  post(path, json) {
    return this.api("POST", path, json === undefined ? {} : json);
  }
  put(path, json) {
    return this.api("PUT", path, json);
  }
  patch(path, json) {
    return this.api("PATCH", path, json);
  }
}

// ─── credentials, read at runtime and never written to a committed file ──────

/** Parse the gitignored `| email | name | company | password |` table. */
function readAccountTable(file) {
  const text = readFileSync(file, "utf8");
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^-+$/.test(cells[0].replace(/[:\s]/g, ""))) continue; // separator row
    if (!cells[0].includes("@")) continue; // header row
    rows.push({
      email: cells[0].toLowerCase(),
      name: cells[1],
      company: cells[2],
      password: cells[3].replace(/`/g, "").trim(),
    });
  }
  return rows;
}

/**
 * The password shared by the six showcase role accounts.
 *
 * `DEMO_ROLE_PASSWORD` wins. Otherwise one is generated ONCE and kept in the
 * gitignored workbook directory beside PROD-USERS.md, so the second run signs
 * the same accounts in rather than inventing a password they do not have.
 */
function resolveRolePassword() {
  if (process.env.DEMO_ROLE_PASSWORD) {
    return {
      password: process.env.DEMO_ROLE_PASSWORD,
      source: "DEMO_ROLE_PASSWORD",
    };
  }
  if (existsSync(DEMO_CREDENTIALS_FILE)) {
    const match = readFileSync(DEMO_CREDENTIALS_FILE, "utf8").match(
      /^password:\s*`?(.+?)`?\s*$/m,
    );
    if (match) return { password: match[1], source: DEMO_CREDENTIALS_FILE };
    fail(`${DEMO_CREDENTIALS_FILE} exists but carries no "password:" line.`);
  }
  const password = `Demo-${randomBytes(9).toString("base64url")}!7`;
  writeFileSync(
    DEMO_CREDENTIALS_FILE,
    [
      "# hosmos demo showcase accounts — GENERATED, gitignored, do not commit",
      "",
      `password: \`${password}\``,
      "",
      "The six accounts below share it. Change it in the product after the demo.",
      "",
      ...SHOWCASE_MEMBERS.map((m) => `- ${m.email} — ${m.role}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { password, source: `${DEMO_CREDENTIALS_FILE} (generated now)` };
}

// ─── the demo dataset ────────────────────────────────────────────────────────

const SHOWCASE_COMPANY = "Nordvind Foods d.o.o.";
const MIDFLOW_COMPANY = "Adriatic Textile d.o.o.";

/** The six roles, as six loginable accounts of ONE company. */
const SHOWCASE_MEMBERS = [
  {
    role: "esg_admin",
    email: "nordvind.esgadmin@demo.hosmos.eu",
    name: "Eva Kovač (ESG admin)",
  },
  {
    role: "data_owner",
    email: "nordvind.dataowner@demo.hosmos.eu",
    name: "Damir Oblak (data owner)",
  },
  {
    role: "contributor",
    email: "nordvind.contributor@demo.hosmos.eu",
    name: "Cvetka Novak (contributor)",
  },
  {
    role: "reviewer",
    email: "nordvind.reviewer@demo.hosmos.eu",
    name: "Rok Zupan (reviewer)",
  },
  {
    role: "approver",
    email: "nordvind.approver@demo.hosmos.eu",
    name: "Ana Perko (approver)",
  },
  {
    role: "auditor",
    email: "nordvind.auditor@demo.hosmos.eu",
    name: "Tomaž Bregar (auditor)",
  },
];

const MIDFLOW_ADMIN = {
  role: "esg_admin",
  email: "adriatic.esgadmin@demo.hosmos.eu",
  name: "Marta Šimunić (ESG admin)",
};

/** A small European food producer's year. Plausible, not lorem ipsum. */
const MONTHS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];
/**
 * Bakery ovens + space heating: a deep winter, a shallow summer.
 *
 * IN STANDARD CUBIC METRES, which is what the distribution operator bills and —
 * not by coincidence — the unit `si-2025` prices natural gas in NATIVELY
 * (`arso_si_2025_natural_gas_nm3`, 2.0633235 kgCO2e/m³). Entering the same year
 * in `kWh_gross` would be the one route this set deliberately refuses: ARSO does
 * not publish a gross basis, so the set owns no `kWh_gross` conversion at all
 * and the row would fail `failed_unit`.
 */
const HQ_GAS_M3 = [
  4067, 3728, 3215, 2479, 1830, 1385, 1240, 1269, 1685, 2595, 3476, 3989,
];
// Office + production electricity: flat, with a small summer cooling bump.
const HQ_ELEC_KWH = [
  28400, 26900, 27600, 25300, 26100, 27800, 29600, 29100, 26400, 26700, 27300,
  28900,
];
// Cold store: refrigeration, so the curve is the inverse of the gas one.
const COLD_ELEC_KWH = [
  31200, 29400, 30800, 32600, 36900, 41300, 44700, 44100, 38500, 33200, 30600,
  31800,
];
// A distribution hub: lighting, docks, chargers.
const HUB_ELEC_KWH = [
  9800, 9200, 9600, 9400, 9900, 10600, 11200, 11000, 10100, 9700, 9500, 9900,
];
/**
 * Gas oil for the Celje hub's standby generator and yard forklifts, in litres.
 *
 * THIS USED TO BE A VAN FLEET, and it had to stop being one. Mobile combustion
 * is keyed on {@link VEHICLE_TYPES}, every one of which resolves on `km`, and
 * `si-2025` prices NONE of the 36 — a fleet row is a guaranteed
 * `failed_missing_factor`. `gas_oil` in LITRES is the same diesel bought the
 * same way, and the set prices it nationally (`arso_si_2025_gas_oil_litre`,
 * 2.6673777 kgCO2e/L). `diesel_mineral` would not do either: it is on the list
 * of fuels this set refuses on purpose.
 */
const HUB_GAS_OIL_L = [
  1180, 1090, 1240, 1210, 1300, 1350, 1180, 1120, 1290, 1330, 1260, 1220,
];

/**
 * The narrative half of the report — real VSME Basic metric keys.
 *
 * The value FIELD is decided by the metric's `value_type` in `metric_catalog`,
 * not by the caller: `enum` and `multi_enum` land in `value_json` even when the
 * value itself is one plain string, and sending `value_text` for one is a 422.
 */
const DISCLOSURES = [
  { metric_key: "VSME-001", value_json: "Basic Module" },
  { metric_key: "VSME-003", value_json: "Consolidated" },
  { metric_key: "VSME-008", value_numeric: 4250000 },
  { metric_key: "VSME-009", value_numeric: 6800000 },
  { metric_key: "VSME-010", value_numeric: 48 },
  { metric_key: "VSME-011", value_text: "Slovenia" },
  { metric_key: "VSME-018", value_boolean: true },
  { metric_key: "VSME-019", value_boolean: true },
  { metric_key: "VSME-022", value_boolean: true },
  { metric_key: "VSME-043", value_numeric: 3150 },
  { metric_key: "VSME-045", value_numeric: 1890 },
  { metric_key: "VSME-047", value_numeric: 62.4 },
];

// ─── generated evidence files ────────────────────────────────────────────────

/**
 * A one-page PDF, hand-assembled.
 *
 * The evidence library refuses anything whose extension and declared MIME
 * disagree (EV-0), so a demo document has to be a real PDF and not a renamed
 * text file. Building the smallest legal one here keeps the seeder dependency-free.
 */
function tinyPdf(title, lines) {
  const escape = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = [
    "BT /F1 14 Tf 56 780 Td (" + escape(title) + ") Tj ET",
    ...lines.map(
      (line, i) => `BT /F1 10 Tf 56 ${752 - i * 16} Td (${escape(line)}) Tj ET`,
    ),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** The evidence pack: one document per source of numbers, as a real company has. */
const EVIDENCE = {
  gas: {
    file_name: "Gas invoices 2025 - Ljubljana HQ.pdf",
    mime: "application/pdf",
    issuer: "Energetika Ljubljana d.o.o.",
    bytes: () =>
      tinyPdf("Natural gas invoices 2025 - Ljubljana HQ & Bakery", [
        "Meter 8801-4471, monthly billed volume in standard cubic metres.",
        "Annual total: 30 958 m3.",
        "Issued by Energetika Ljubljana d.o.o.",
      ]),
  },
  electricity: {
    file_name: "Electricity invoices 2025 - all sites.pdf",
    mime: "application/pdf",
    issuer: "Elektro Ljubljana d.d.",
    bytes: () =>
      tinyPdf("Electricity invoices 2025 - Nordvind Foods", [
        "Ljubljana HQ & Bakery, Maribor Cold Store, Celje Distribution Hub.",
        "Monthly metered consumption, kWh, per delivery point.",
        "Annual total: 875 100 kWh.",
      ]),
  },
  diesel: {
    file_name: "Gas oil delivery notes 2025.pdf",
    mime: "application/pdf",
    issuer: "OMV Slovenija d.o.o.",
    bytes: () =>
      tinyPdf("Gas oil delivery notes 2025 - Celje Distribution Hub", [
        "Standby generator and yard forklifts, litres delivered per month.",
        "Annual total: 14 770 L.",
      ]),
  },
  refrigerant: {
    file_name: "Refrigerant service report 2025.pdf",
    mime: "application/pdf",
    issuer: "Hladilna tehnika Maribor d.o.o.",
    bytes: () =>
      tinyPdf("Refrigerant service report 2025 - Maribor Cold Store", [
        "R-134a, opening stock 45.0 kg, charged 14.5 kg, recovered 1.5 kg.",
        "Closing stock 46.0 kg. Mass balance leakage: 12.0 kg.",
      ]),
  },
  goo: {
    file_name: "Guarantee of Origin GO-SI-2025-000417.pdf",
    mime: "application/pdf",
    issuer: "Borzen d.o.o.",
    bytes: () =>
      tinyPdf("Guarantee of Origin GO-SI-2025-000417", [
        "120 MWh, solar, produced in Slovenia, vintage 2025.",
        "Cancelled on behalf of Nordvind Foods d.o.o. on 2026-02-14.",
      ]),
  },
  pack: {
    file_name: "Sustainability data pack 2025.csv",
    mime: "text/csv",
    issuer: "Nordvind Foods d.o.o.",
    bytes: () =>
      Buffer.from(
        [
          "metric,value,unit,source",
          "balance_sheet_total,4250000,EUR,annual accounts 2025",
          "turnover,6800000,EUR,annual accounts 2025",
          "employees_fte,48,FTE,payroll export 2025-12",
          "water_withdrawal,3150,m3,water utility invoices 2025",
          "water_consumption,1890,m3,water balance 2025",
          "waste_total,62.4,t,waste transfer notes 2025",
          "",
        ].join("\n"),
        "utf8",
      ),
  },
};

// ─── find-or-create helpers over the product's own endpoints ─────────────────

/**
 * Mark ONE seeded address as verified. Returns true if a row actually moved.
 *
 * WHY THIS EXISTS. Production runs with `REQUIRE_EMAIL_VERIFICATION=true`, so
 * better-auth issues no session until the address is confirmed — a sign-up
 * answers 200 and hands back nothing, and every call after it is anonymous. The
 * confirmation arrives by email, at an inbox this script does not have.
 *
 * WHY NOT FLIP THE ENV VAR INSTEAD. That setting protects real sign-ups, and
 * turning it off for the length of a seeding run would take it off for everyone
 * who registered during that window — and would need two app restarts, each a
 * blip on a live site. This touches exactly the addresses the seeder itself
 * just created, by literal email, one row at a time. Nothing else is relaxed.
 *
 * The `where email_verified = false` clause is what makes it honest: it can
 * only ever move an account from unverified to verified, never re-confirm one a
 * human already confirmed, and the row count tells the caller which happened.
 */
async function markEmailVerified(email) {
  const moved = await sql`
    update "user" set email_verified = true
    where email = ${email} and email_verified = false`;
  return moved.count > 0;
}

async function ensureAccount(session, { email, password, name }) {
  let signIn = await session.call("POST", "/api/auth/sign-in/email", {
    json: { email, password },
  });
  if (signIn.status === 200) return { created: false };

  // An account left unverified by an earlier interrupted run: confirm it and
  // retry before concluding it does not exist. Without this the sign-up below
  // would answer "user already exists" and the run would stop on an account
  // that is merely one column away from usable.
  if (await markEmailVerified(email)) {
    signIn = await session.call("POST", "/api/auth/sign-in/email", {
      json: { email, password },
    });
    if (signIn.status === 200) return { created: false };
  }

  const signUp = await session.call("POST", "/api/auth/sign-up/email", {
    json: { email, password, name },
  });
  if (signUp.status !== 200) {
    fail(
      `sign-up for ${email} → ${signUp.status} ${JSON.stringify(signUp.body)}` +
        (signIn.status === 401
          ? " (and sign-in was refused, so the password on file is not this account's)"
          : ""),
    );
  }

  // Where verification is NOT required the sign-up already left a session and
  // this is a second, harmless one; where it IS required the sign-up left none,
  // and this is the call that makes the account usable. Signing in either way
  // keeps the two environments on one path instead of branching on a setting
  // this script cannot see.
  await markEmailVerified(email);
  const after = await session.call("POST", "/api/auth/sign-in/email", {
    json: { email, password },
  });
  if (after.status !== 200) {
    fail(
      `sign-in after sign-up for ${email} → ${after.status} ` +
        `${JSON.stringify(after.body)} (the account exists but issues no session)`,
    );
  }
  return { created: true };
}

/** The company a session is acting for, or null. */
async function sessionCompany(session) {
  const res = await session.call("GET", "/api/session");
  if (res.status !== 200 || !res.body) fail("GET /api/session did not answer");
  return res.body.company ?? null;
}

async function ensureOwnedCompany(session, name) {
  const existing = await sessionCompany(session);
  if (existing) {
    found("company", existing.name);
    return existing;
  }
  await session.post("/api/register", { company: name });
  const created = await sessionCompany(session);
  if (!created) fail(`POST /api/register did not attach the company "${name}"`);
  made("company", name);
  return created;
}

/**
 * Patch the company profile ONLY where it actually differs.
 *
 * `PATCH /api/company` writes an `audit_log` row on every successful call,
 * unconditionally — which is right for the product (somebody pressed Save) and
 * wrong for a seeder that runs twice. Comparing first is what makes the second
 * run a genuine no-op rather than a no-op with a paper trail.
 */
async function ensureCompanyProfile(session, wanted) {
  const company = await sessionCompany(session);
  const patch = {};
  for (const [key, value] of Object.entries(wanted)) {
    if ((company[key] ?? null) !== value) patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return;
  await session.patch("/api/company", patch);
  note(`company profile updated: ${Object.keys(patch).join(", ")}`);
}

async function ensurePlan(session, plan) {
  const company = await sessionCompany(session);
  if (company.plan === plan) return;
  await session.post("/api/company/plan", { plan });
  note(`plan ${company.plan} → ${plan}`);
}

/** Generic find-or-create against a list endpoint. `key` names the row. */
async function ensureRow(
  session,
  { kind, listPath, listKey, match, create, createPath },
) {
  const list = await session.get(listPath);
  const rows = Array.isArray(list) ? list : list[listKey];
  const hit = rows.find(match);
  if (hit) {
    found(kind, create.__label);
    return hit;
  }
  const body = { ...create };
  delete body.__label;
  const row = await session.post(createPath || listPath, body);
  made(kind, create.__label);
  return row;
}

// ─── the four input-row families ─────────────────────────────────────────────

const FAMILIES = {
  emission: { path: "/api/activities/emission", listKey: "activities" },
  energy: { path: "/api/activities/energy", listKey: "activities" },
  instruments: { path: "/api/activities/instruments", listKey: "instruments" },
  disclosures: { path: "/api/disclosures", listKey: "disclosures" },
};

/** Current rows of a revision, per family, keyed by the caller's identity fn. */
async function loadRows(session, family, revisionId) {
  const f = FAMILIES[family];
  const data = await session.get(`${f.path}?revision_id=${revisionId}`);
  return data[f.listKey];
}

// ─── main ────────────────────────────────────────────────────────────────────

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

/**
 * THE ONE THING SQL DOES. A membership carries the role, and a role cannot be
 * granted over HTTP: the invitation endpoint mails a token whose hash alone is
 * stored, so accepting it needs an inbox. Upsert on the natural key so a second
 * run corrects a role rather than colliding with it.
 */
async function ensureMembership(companyId, email, role) {
  const [account] = await sql`
    select id from "user" where lower(email) = ${email.toLowerCase()} limit 1`;
  if (!account)
    fail(`no auth user for ${email} — sign-up did not reach this database`);

  const [before] = await sql`
    select role, status from company_members
    where company_id = ${companyId} and user_id = ${account.id} limit 1`;

  await sql`
    insert into company_members (id, company_id, user_id, role, status, accepted_at)
    values (${randomUUID()}, ${companyId}, ${account.id}, ${role}, 'active', now())
    on conflict (company_id, user_id) do update
      set role = excluded.role, status = 'active',
          accepted_at = coalesce(company_members.accepted_at, excluded.accepted_at),
          updated_at = now()`;

  if (!before) made("membership", `${email} → ${role}`);
  else if (before.role !== role || before.status !== "active")
    note(
      `membership ${email}: ${before.role}/${before.status} → ${role}/active`,
    );
  else found("membership", `${email} → ${role}`);
  return account.id;
}

/** Upload a document once; a second run finds it by file name. */
async function ensureDocument(session, spec) {
  const list = await session.get("/api/documents");
  const hit = list.documents.find((d) => d.file_name === spec.file_name);
  if (hit) {
    found("document", spec.file_name);
    return hit;
  }
  const boundary = `----hosmosdemo${randomBytes(12).toString("hex")}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, "utf8"));
  push(`--${boundary}\r\n`);
  push(
    `Content-Disposition: form-data; name="file"; filename="${spec.file_name}"\r\n` +
      `Content-Type: ${spec.mime}\r\n\r\n`,
  );
  parts.push(spec.bytes());
  push("\r\n");
  for (const [field, value] of Object.entries({
    file_name: spec.file_name,
    issuer: spec.issuer,
    document_date: "2026-01-31",
    coverage_start: "2025-01-01",
    coverage_end: "2025-12-31",
    confidentiality: "internal",
  })) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`,
    );
  }
  push(`--${boundary}--\r\n`);
  const body = Buffer.concat(parts);

  const res = await session.call("POST", "/api/documents", {
    body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  if (res.status !== 200 || !res.body?.ok) {
    fail(
      `upload ${spec.file_name} → ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  made("document", spec.file_name);
  return res.body.data.document;
}

async function ensureEvidenceLink(session, documentId, objectType, objectId) {
  // POST is itself idempotent on the triple and answers `created:false`.
  await session.post("/api/evidence-links", {
    documentId,
    objectType,
    objectId,
  });
}

async function setDq(session, objectType, objectId, assessment) {
  await session.put(`/api/dq/${objectType}/${objectId}`, assessment);
}

/**
 * Walk a revision forward to `target`, using the role that owns each step.
 * Driven from the CURRENT status, so a second run finds it already there.
 */
async function advanceRevision(revisionId, target, actors) {
  const order = ["draft", "submitted", "in_review", "approved", "locked"];
  const plan = [
    { from: "draft", action: "submit", by: actors.submit },
    { from: "submitted", action: "start_review", by: actors.review },
    { from: "in_review", action: "approve", by: actors.approve },
    { from: "approved", action: "lock", by: actors.approve },
  ];
  for (const move of plan) {
    const summary = await actors.read.get(`/api/revisions/${revisionId}`);
    const status = summary.revision.status;
    if (order.indexOf(status) >= order.indexOf(target)) break;
    if (status !== move.from) continue;
    const moved = await move.by.post(
      `/api/revisions/${revisionId}/transition`,
      {
        action: move.action,
      },
    );
    note(`revision ${moved.from} → ${moved.to} (by ${move.by.label})`);
  }
  const final = await actors.read.get(`/api/revisions/${revisionId}`);
  if (final.revision.status !== target) {
    fail(
      `revision stopped at "${final.revision.status}", expected "${target}" — ` +
        `blocking codes: ${JSON.stringify(final.validation.blocking_codes)}`,
    );
  }
}

async function main() {
  console.log(`demo-seed: app ${BASE_URL}`);
  console.log(
    `demo-seed: database ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`,
  );

  // ── 0. credentials ────────────────────────────────────────────────────────
  step("0. Credentials (read at runtime, never committed)");
  let prodAccounts = [];
  if (SKIP_PROD_USERS) {
    note("SKIP_PROD_USERS=1 — the ten production accounts are skipped.");
  } else if (existsSync(PROD_USERS_FILE)) {
    prodAccounts = readAccountTable(PROD_USERS_FILE);
    note(`${prodAccounts.length} accounts read from ${PROD_USERS_FILE}`);
    if (prodAccounts.length === 0)
      fail(`no account rows found in ${PROD_USERS_FILE}`);
  } else {
    fail(
      `${PROD_USERS_FILE} not found. Point PROD_USERS_FILE at it, ` +
        `or set SKIP_PROD_USERS=1 to seed only the showcase companies.`,
    );
  }
  const role = resolveRolePassword();
  note(`showcase role password from ${role.source}`);

  // ── 1. preflight: the app and this script must share one database ─────────
  step("1. Preflight — the app and DATABASE_URL must be the same database");
  const probe = new Session("preflight");
  const probeEmail = SHOWCASE_MEMBERS[0].email;
  await ensureAccount(probe, {
    email: probeEmail,
    password: role.password,
    name: SHOWCASE_MEMBERS[0].name,
  });
  const [seen] = await sql`
    select id from "user" where lower(email) = ${probeEmail} limit 1`;
  if (!seen) {
    fail(
      `the account created through ${BASE_URL} is not visible in DATABASE_URL — ` +
        `the running app is pointed at a different database.`,
    );
  }
  note("the app writes into the database this script reads. Good.");

  /**
   * `fx_rates` is REFERENCE data and this script does not write reference data.
   * But it is worth SAYING when it is missing, because the symptom is silent:
   * `resolveFxRateMap` omits a currency with no row at all, `convertToEur` then
   * returns null, and the GHG intensity (VSME B3) is withheld rather than being
   * quietly computed at 1.0. On a database built by migrations alone the table
   * is EMPTY — the rates live in `src/server/db/seed.ts` (which CI runs and the
   * server cannot), not in `drizzle/0004_data_model.sql` — so every company on
   * such a deployment shows a blank intensity, demo or not.
   */
  const [{ count: fxCount }] =
    await sql`select count(*)::int as count from fx_rates`;
  if (fxCount === 0) {
    advisories.push(
      "fx_rates is EMPTY on this database, so GHG intensity (VSME B3) will be " +
        "blank for every company — the calculation withholds it rather than " +
        "assuming a rate. The values live in src/server/db/seed.ts (`npm run " +
        "db:seed`); a deployment that only ever runs migrations never gets them. " +
        "This seeder does not write reference data.",
    );
    note(
      "WARNING: fx_rates is empty — GHG intensity will be blank (see the summary).",
    );
  }

  // ── 2. the ten production accounts, each with its own company ─────────────
  if (prodAccounts.length > 0) {
    step("2. Production accounts and their companies");
    for (const account of prodAccounts) {
      const s = new Session(account.email);
      const { created } = await ensureAccount(s, account);
      if (created) made("account", account.email);
      else found("account", account.email);
      await ensureOwnedCompany(s, account.company);
    }
  } else {
    step("2. Production accounts — skipped");
  }

  // ── 3. the showcase company and its six roles ─────────────────────────────
  step("3. Showcase company — six roles, six loginable accounts");
  const sessions = {};
  for (const member of SHOWCASE_MEMBERS) {
    const s = new Session(member.role);
    const { created } = await ensureAccount(s, {
      email: member.email,
      password: role.password,
      name: member.name,
    });
    if (created) made("account", `${member.email} (${member.role})`);
    else found("account", `${member.email} (${member.role})`);
    sessions[member.role] = s;
  }

  const admin = sessions.esg_admin;
  const company = await ensureOwnedCompany(admin, SHOWCASE_COMPANY);

  // Every other role is attached by SQL — see `ensureMembership`.
  for (const member of SHOWCASE_MEMBERS) {
    await ensureMembership(company.id, member.email, member.role);
  }
  // The admin's session was resolved before the approver existed, so its
  // capability set still carries the D13 `data.approve` grant. Re-signing in is
  // what a demo-er would see anyway: the moment an approver exists, the admin
  // stops being able to approve.
  for (const member of SHOWCASE_MEMBERS) {
    await ensureAccount(sessions[member.role], {
      email: member.email,
      password: role.password,
      name: member.name,
    });
  }

  // Pro: 3 legal entities, 15 facilities, consolidated reporting, pdf + xlsx.
  await ensurePlan(admin, "pro");
  await ensureCompanyProfile(admin, {
    industry: "Food manufacturing",
    country: "Slovenia",
    nace_code: "10.71",
    headcount: 48,
    currency: "EUR",
  });

  // ── 4. the organisation ───────────────────────────────────────────────────
  step("4. Organisation — a parent, a subsidiary and one entity left out");
  const parent = await ensureRow(admin, {
    kind: "legal entity",
    listPath: "/api/org/entities",
    listKey: "entities",
    match: (e) => e.organisation_name === SHOWCASE_COMPANY,
    create: {
      __label: SHOWCASE_COMPANY,
      organisation_name: SHOWCASE_COMPANY,
      registration_number: "SI-1094771000",
      vat_number: "SI40118322",
      registered_address: "Vodovodna cesta 101, 1000 Ljubljana, Slovenia",
      country: "SI",
      nace_code: "10.71",
      reporting_currency: "EUR",
      employee_count: 34,
      average_fte: 33.2,
      turnover: 5100000,
      group_structure_type: "parent",
      effective_from: "2011-03-14",
    },
  });
  const subsidiary = await ensureRow(admin, {
    kind: "legal entity",
    listPath: "/api/org/entities",
    listKey: "entities",
    match: (e) => e.organisation_name === "Nordvind Logistika d.o.o.",
    create: {
      __label: "Nordvind Logistika d.o.o. (subsidiary)",
      organisation_name: "Nordvind Logistika d.o.o.",
      registration_number: "SI-6612480000",
      vat_number: "SI71905544",
      registered_address: "Ipavčeva ulica 18, 3000 Celje, Slovenia",
      country: "SI",
      nace_code: "49.41",
      reporting_currency: "EUR",
      employee_count: 14,
      average_fte: 13.6,
      turnover: 1700000,
      group_structure_type: "subsidiary",
      parent_organisation_id: parent.id,
      consolidation_method: "operational_control",
      ownership_percentage: 100,
      effective_from: "2016-09-01",
    },
  });
  const outsider = await ensureRow(admin, {
    kind: "legal entity",
    listPath: "/api/org/entities",
    listKey: "entities",
    match: (e) => e.organisation_name === "Nordvind Trading GmbH",
    create: {
      __label: "Nordvind Trading GmbH (excluded from the boundary)",
      organisation_name: "Nordvind Trading GmbH",
      registration_number: "FN-518842v",
      registered_address: "Mariahilfer Straße 88, 1070 Wien, Austria",
      country: "AT",
      nace_code: "46.38",
      reporting_currency: "EUR",
      employee_count: 3,
      average_fte: 2.8,
      turnover: 480000,
      group_structure_type: "subsidiary",
      parent_organisation_id: parent.id,
      consolidation_method: "equity_share",
      ownership_percentage: 34,
      effective_from: "2023-04-01",
      exclusion_reason:
        "Equity-share holding below operational control; immaterial (<3% of group turnover).",
    },
  });

  const facilitySpecs = [
    {
      facility_name: "Ljubljana HQ & Bakery",
      legal_entity_id: parent.id,
      facility_type: "plant",
      address: "Vodovodna cesta 101, 1000 Ljubljana",
      postal_code: "1000",
      country: "SI",
      latitude: 46.0755,
      longitude: 14.5122,
      tenure: "owned",
      control_status: "controlled",
      floor_area: 2400,
      opening_date: "2011-03-14",
      included_in_boundary: true,
      boundary_classification: "scope_1_2",
    },
    {
      facility_name: "Maribor Cold Store",
      legal_entity_id: parent.id,
      facility_type: "warehouse",
      address: "Tržaška cesta 37, 2000 Maribor",
      postal_code: "2000",
      country: "SI",
      latitude: 46.5547,
      longitude: 15.6459,
      tenure: "leased",
      control_status: "controlled",
      floor_area: 1850,
      opening_date: "2018-05-02",
      included_in_boundary: true,
      boundary_classification: "scope_1_2",
    },
    {
      facility_name: "Celje Distribution Hub",
      legal_entity_id: subsidiary.id,
      facility_type: "warehouse",
      address: "Ipavčeva ulica 18, 3000 Celje",
      postal_code: "3000",
      country: "SI",
      latitude: 46.2311,
      longitude: 15.2603,
      tenure: "leased",
      control_status: "controlled",
      floor_area: 1200,
      opening_date: "2016-09-01",
      included_in_boundary: true,
      boundary_classification: "scope_1_2",
    },
    {
      facility_name: "Vienna Sales Office",
      legal_entity_id: outsider.id,
      facility_type: "office",
      address: "Mariahilfer Straße 88, 1070 Wien",
      postal_code: "1070",
      country: "AT",
      tenure: "leased",
      control_status: "not_controlled",
      floor_area: 140,
      opening_date: "2023-04-01",
      included_in_boundary: false,
      boundary_classification: "outside_scopes",
    },
  ];
  const facilities = {};
  for (const spec of facilitySpecs) {
    facilities[spec.facility_name] = await ensureRow(admin, {
      kind: "facility",
      listPath: "/api/org/facilities",
      listKey: "facilities",
      match: (f) => f.facility_name === spec.facility_name,
      create: { __label: spec.facility_name, ...spec },
    });
  }

  const assetSpecs = [
    {
      name: "Bakery gas boiler B-1",
      asset_type: "equipment",
      legal_entity_id: parent.id,
      facility_id: facilities["Ljubljana HQ & Bakery"].id,
      identifier: "VIESSMANN-VT200-8801",
      notes: "600 kW condensing boiler, ovens plus space heating.",
    },
    {
      name: "Electricity meter LJ-HQ",
      asset_type: "meter",
      legal_entity_id: parent.id,
      facility_id: facilities["Ljubljana HQ & Bakery"].id,
      identifier: "SI-EL-8801-4471",
    },
    {
      name: "Electricity meter MB-COLD",
      asset_type: "meter",
      legal_entity_id: parent.id,
      facility_id: facilities["Maribor Cold Store"].id,
      identifier: "SI-EL-2033-9010",
    },
    {
      name: "Electricity meter CE-HUB",
      asset_type: "meter",
      legal_entity_id: subsidiary.id,
      facility_id: facilities["Celje Distribution Hub"].id,
      identifier: "SI-EL-3110-2288",
    },
    {
      // NOT a vehicle. See `HUB_GAS_OIL_L`: `si-2025` prices no per-km fleet
      // factor, so the demo burns its diesel in equipment that is priced by the
      // litre instead of in vans that could not be priced at all.
      name: "Standby generator & yard forklifts",
      asset_type: "equipment",
      legal_entity_id: subsidiary.id,
      facility_id: facilities["Celje Distribution Hub"].id,
      identifier: "CE-GENSET-2019",
      notes:
        "250 kVA diesel standby set plus three counterbalance forklifts, fuelled from the yard tank.",
    },
  ];
  const assets = {};
  for (const spec of assetSpecs) {
    assets[spec.name] = await ensureRow(admin, {
      kind: "asset",
      listPath: "/api/org/assets",
      listKey: "assets",
      match: (a) => a.name === spec.name,
      create: { __label: spec.name, ...spec },
    });
  }

  // ── 5. the period, its pinned factor set and its boundary ─────────────────
  //
  // WHY FY2025 AND NOT FY2024. All 13 Slovenian rows in `si-2025` carry
  // `applicable_year = 2025`, and a factor published for another year is a
  // different measurement rather than an approximation (T5.1) — so under a 2024
  // period every one of them is invisible and each row falls to whatever
  // year-agnostic international default it can reach. For gas and diesel that is
  // a silent 7%-ish swing to an IPCC 2006 GLOBAL number; for ELECTRICITY it is
  // not a swing but a hole, because the set holds no global grid factor at all
  // and every purchased-energy line fails outright. Reporting the year the
  // national factors were published is what makes the demo green AND correct.
  step("5. Reporting period, pinned factor set, boundary with a reason");
  const period = await ensureRow(admin, {
    kind: "period",
    listPath: "/api/periods",
    listKey: "periods",
    match: (p) => p.period_name === "FY2025",
    create: {
      __label: "FY2025 (consolidated)",
      period_name: "FY2025",
      start_date: "2025-01-01",
      end_date: "2025-12-31",
      reporting_year: 2025,
      base_year: 2024,
      reporting_basis: "consolidated",
    },
  });
  note(
    `factor set pinned: ${period.factor_set_version ?? period.factor_set_id}`,
  );

  // The boundary must be written BEFORE the revision leaves draft: VAL-106
  // freezes it afterwards. `PUT` is a full replacement, so it is idempotent.
  const boundaryWanted = [
    { legal_entity_id: parent.id, status: "included" },
    { legal_entity_id: subsidiary.id, status: "included" },
    {
      legal_entity_id: outsider.id,
      status: "excluded",
      exclusion_reason:
        "Equity-share holding (34%) without operational control; immaterial — below 3% of group turnover.",
    },
  ];
  const boundaryNow = await admin.get(`/api/periods/${period.id}/scope`);
  const same =
    boundaryNow.entries.length === boundaryWanted.length &&
    boundaryWanted.every((w) =>
      boundaryNow.entries.some(
        (e) =>
          e.legal_entity_id === w.legal_entity_id &&
          e.status === w.status &&
          (e.exclusion_reason ?? null) === (w.exclusion_reason ?? null),
      ),
    );
  if (same) found("boundary", "3 entities (1 excluded, with its reason)");
  else {
    await admin.put(`/api/periods/${period.id}/scope`, {
      entries: boundaryWanted,
    });
    made("boundary", "3 entities (1 excluded, with its reason)");
  }

  // ── 6. the revision and its rows ──────────────────────────────────────────
  step("6. Revision and the year's data (entered by the contributor)");
  const contributor = sessions.contributor;
  const revisions = await contributor.get(
    `/api/periods/${period.id}/revisions`,
  );
  let revision = revisions.revisions.find((r) => r.is_current);
  if (revision)
    found("revision", `no.${revision.revision_no} (${revision.status})`);
  else {
    revision = await contributor.post(
      `/api/periods/${period.id}/revisions`,
      {},
    );
    made("revision", `no.${revision.revision_no}`);
  }

  const mutable = revision.status === "draft" || revision.status === "rejected";

  /**
   * The full year, as a flat plan. Each entry knows how to identify itself in a
   * list, which is what makes the whole phase idempotent.
   */
  const hq = facilities["Ljubljana HQ & Bakery"];
  const cold = facilities["Maribor Cold Store"];
  const hub = facilities["Celje Distribution Hub"];

  const plan = [];
  MONTHS.forEach((month, i) => {
    plan.push({
      family: "emission",
      evidence: "gas",
      dq: {
        reliability_score: 5,
        temporal_score: 5,
        geographical_score: 5,
        technology_score: 4,
        completeness_score: 100,
        quality_tier: "high_primary",
        is_overridden: false,
        quality_comment:
          "Metered, billed monthly by the distribution operator.",
      },
      id: (r) =>
        r.activity_category === "stationary_combustion" &&
        r.activity_type === "natural_gas" &&
        r.year_month === `2025-${month}`,
      body: {
        revision_id: revision.id,
        legal_entity_id: parent.id,
        facility_id: hq.id,
        asset_id: assets["Bakery gas boiler B-1"].id,
        activity_category: "stationary_combustion",
        source_name: "Bakery gas boiler B-1",
        activity_type: "natural_gas",
        activity_value: HQ_GAS_M3[i],
        method: "fuel_based",
        unit: "m3",
        year_month: `2025-${month}`,
        notes:
          "Metered standard cubic metres from the distribution operator's invoice.",
      },
    });
    const electricity = [
      {
        facility: hq,
        entity: parent,
        meter: "Electricity meter LJ-HQ",
        kwh: HQ_ELEC_KWH[i],
        supplier: "Elektro Ljubljana d.d.",
        renewable: 41,
      },
      {
        facility: cold,
        entity: parent,
        meter: "Electricity meter MB-COLD",
        kwh: COLD_ELEC_KWH[i],
        supplier: "Elektro Maribor d.d.",
        renewable: 41,
      },
      {
        facility: hub,
        entity: subsidiary,
        meter: "Electricity meter CE-HUB",
        kwh: HUB_ELEC_KWH[i],
        supplier: "Elektro Celje d.d.",
        renewable: 41,
      },
    ];
    for (const e of electricity) {
      plan.push({
        family: "energy",
        evidence: "electricity",
        dq: {
          reliability_score: 5,
          temporal_score: 5,
          geographical_score: 5,
          technology_score: 4,
          completeness_score: 100,
          quality_tier: "high_primary",
          is_overridden: false,
          quality_comment:
            "Half-hourly metered, invoiced monthly per delivery point.",
        },
        id: (r) =>
          r.energy_type === "electricity" &&
          r.facility_id === e.facility.id &&
          r.year_month === `2025-${month}`,
        body: {
          revision_id: revision.id,
          legal_entity_id: e.entity.id,
          facility_id: e.facility.id,
          meter_asset_id: assets[e.meter].id,
          energy_type: "electricity",
          supplier: e.supplier,
          consumption: e.kwh,
          renewable_share: e.renewable,
          unit: "kWh",
          year_month: `2025-${month}`,
          notes: "Metered consumption from the supplier's monthly invoice.",
        },
      });
    }
    plan.push({
      family: "emission",
      evidence: "diesel",
      dq: {
        reliability_score: 4,
        temporal_score: 5,
        geographical_score: 4,
        technology_score: 4,
        completeness_score: 100,
        quality_tier: "high_primary",
        is_overridden: false,
        quality_comment:
          "Litres delivered to the yard tank, reconciled to the delivery notes.",
      },
      id: (r) =>
        r.activity_category === "stationary_combustion" &&
        r.activity_type === "gas_oil" &&
        r.year_month === `2025-${month}`,
      body: {
        revision_id: revision.id,
        legal_entity_id: subsidiary.id,
        facility_id: hub.id,
        asset_id: assets["Standby generator & yard forklifts"].id,
        activity_category: "stationary_combustion",
        source_name: "Standby generator & yard forklifts",
        activity_type: "gas_oil",
        activity_value: HUB_GAS_OIL_L[i],
        method: "fuel_based",
        unit: "L",
        year_month: `2025-${month}`,
        notes:
          "Litres drawn from the yard tank at the Celje hub, per delivery note.",
      },
    });
  });

  plan.push({
    family: "emission",
    evidence: "refrigerant",
    dq: {
      reliability_score: 4,
      temporal_score: 4,
      geographical_score: 5,
      technology_score: 4,
      completeness_score: 100,
      quality_tier: "medium_calculated",
      is_overridden: false,
      quality_comment:
        "Mass balance from the annual service report; leakage is the residual.",
    },
    id: (r) =>
      r.activity_category === "fugitive_emissions" &&
      r.activity_type === "r134a",
    body: {
      revision_id: revision.id,
      legal_entity_id: parent.id,
      facility_id: cold.id,
      activity_category: "fugitive_emissions",
      source_name: "Cold store refrigeration pack",
      activity_type: "r134a",
      activity_value: 12,
      method: "mass_balance",
      unit: "kg",
      equipment_capacity: 46,
      opening_stock: 45,
      refrigerant_added: 14.5,
      refrigerant_recovered: 1.5,
      closing_stock: 46,
      notes:
        "R-134a mass balance over the year: 45.0 + 14.5 − 1.5 − 46.0 = 12.0 kg leaked.",
    },
  });

  plan.push({
    family: "instruments",
    evidence: "goo",
    dq: {
      reliability_score: 5,
      temporal_score: 5,
      geographical_score: 5,
      technology_score: 5,
      completeness_score: 100,
      quality_tier: "high_primary",
      is_overridden: false,
      quality_comment:
        "Guarantee of Origin cancelled in the national registry.",
    },
    id: (r) => r.certificate_id === "GO-SI-2025-000417",
    body: {
      revision_id: revision.id,
      legal_entity_id: parent.id,
      instrument_type: "GoO",
      certificate_id: "GO-SI-2025-000417",
      covered_volume: 120,
      residual_mix_volume: null,
      production_country: "SI",
      technology: "solar",
      quality_criteria_status: "pass",
      generation_period_start: "2025-01-01",
      generation_period_end: "2025-12-31",
      cancellation_date: "2026-02-14",
      notes:
        "120 MWh of Slovenian solar GoOs cancelled against the Ljubljana site.",
    },
  });

  for (const disclosure of DISCLOSURES) {
    plan.push({
      family: "disclosures",
      evidence: "pack",
      dq: {
        reliability_score: 4,
        temporal_score: 5,
        geographical_score: 5,
        technology_score: 3,
        completeness_score: 100,
        quality_tier: "medium_calculated",
        is_overridden: false,
        quality_comment:
          "Taken from the annual accounts and the 2025 sustainability data pack.",
      },
      id: (r) => r.metric_key === disclosure.metric_key,
      body: {
        revision_id: revision.id,
        legal_entity_id: parent.id,
        ...disclosure,
      },
    });
  }

  // Documents first — a row's evidence link needs a document to point at.
  const documents = {};
  for (const [key, spec] of Object.entries(EVIDENCE)) {
    documents[key] = await ensureDocument(contributor, spec);
  }

  const OBJECT_TYPE = {
    emission: "emission_activity",
    energy: "purchased_energy_activity",
    instruments: "contractual_instrument",
    disclosures: "disclosure_record",
  };

  if (!mutable) {
    note(`revision is ${revision.status} — rows are frozen, nothing to write.`);
  } else {
    const existing = {};
    for (const family of Object.keys(FAMILIES)) {
      existing[family] = await loadRows(contributor, family, revision.id);
    }
    let createdRows = 0;
    let keptRows = 0;
    for (const entry of plan) {
      let row = existing[entry.family].find(entry.id);
      if (row) keptRows++;
      else {
        row = await contributor.post(FAMILIES[entry.family].path, entry.body);
        existing[entry.family].push(row);
        createdRows++;
      }
      // Evidence and DQ ride the version carry-hooks, so both are set on the
      // draft version and follow it into the approved one.
      await ensureEvidenceLink(
        contributor,
        documents[entry.evidence].id,
        OBJECT_TYPE[entry.family],
        row.id,
      );
      await setDq(contributor, OBJECT_TYPE[entry.family], row.id, entry.dq);
      entry.rowId = row.id;
    }
    if (createdRows) made("input rows", `${createdRows} created`);
    if (keptRows) found("input rows", `${keptRows} already present`);

    // One assessment is deliberately OVERRIDDEN, by the data owner — the only
    // other role that holds `data.review`, which the override needs.
    const overridden = plan.find(
      (e) =>
        e.family === "emission" &&
        e.body.activity_category === "fugitive_emissions",
    );
    await setDq(sessions.data_owner, "emission_activity", overridden.rowId, {
      ...overridden.dq,
      quality_tier: "low_proxy",
      is_overridden: true,
      override_reason:
        "Service report gives stock levels only; the leakage figure is the residual of the mass balance, not a measurement.",
    });
    note("one DQ assessment overridden by the data owner (needs data.review)");

    // ── 7. approvals, by the role whose job it is ───────────────────────────
    step(
      "7. Row approvals (by the approver — data.approve, not the contributor)",
    );
    let approved = 0;
    let already = 0;
    for (const family of Object.keys(FAMILIES)) {
      const rows = await loadRows(sessions.approver, family, revision.id);
      for (const row of rows) {
        if (row.state === "approved") {
          already++;
          continue;
        }
        await sessions.approver.post(
          `${FAMILIES[family].path}/${row.id}/approve`,
        );
        approved++;
      }
    }
    if (approved) made("row approvals", `${approved}`);
    if (already) found("row approvals", `${already} already approved`);
  }

  // ── 8. validation, calculation, the workflow, the renders ────────────────
  step("8. Validation and the calculation run");
  for (const scope of ["reference_org", "period", "revision"]) {
    const target =
      scope === "period"
        ? period.id
        : scope === "revision"
          ? revision.id
          : parent.id;
    await contributor.post("/api/validation/run", { scope, targetId: target });
  }
  note(
    "validation results stored for the organisation, the period and the revision",
  );

  // Calculating LAST — every approval rewrote a row, and a run older than its
  // inputs is refused at `approve` as stale. A run is APPEND-ONLY, so a second
  // seeding pass must not fire one off just to prove it can: an existing green,
  // fresh run is exactly the thing this step was for.
  const existingRun = await contributor.call(
    "GET",
    `/api/revisions/${revision.id}/results`,
  );
  const fresh =
    existingRun.status === 200 &&
    existingRun.body?.data?.run?.status === "ok" &&
    existingRun.body.data.freshness?.stale === false;
  if (fresh) {
    const totals = existingRun.body.data.aggregates.totals;
    found(
      "calculation run",
      `Scope 1 ${totals.scope1Co2e} kgCO2e, Scope 2 (location) ${totals.scope2LocationBasedCo2e} kgCO2e`,
    );
  } else {
    const run = await contributor.post(
      `/api/revisions/${revision.id}/calculate`,
    );
    if (run.run.status !== "ok") {
      fail(
        `calculation run came back "${run.run.status}" with ${run.run.failedCount} ` +
          `failed line(s) of ${run.run.lineCount} — the demo would show holes.`,
      );
    }
    made(
      "calculation run",
      `${run.run.lineCount} lines, Scope 1 ${run.aggregates.totals.scope1Co2e} kgCO2e, ` +
        `Scope 2 (location) ${run.aggregates.totals.scope2LocationBasedCo2e} kgCO2e`,
    );
  }

  step("9. The workflow — submit, review, approve, lock");
  await advanceRevision(revision.id, "locked", {
    read: sessions.esg_admin,
    submit: sessions.contributor,
    review: sessions.reviewer,
    approve: sessions.approver,
  });
  found("revision", "locked");

  step("10. Renders — the immutable PDF and XLSX");
  const existingRenders = await sessions.reviewer.get(
    `/api/renders?revision_id=${revision.id}`,
  );
  for (const format of ["pdf", "xlsx"]) {
    const hit = existingRenders.renders.find(
      (r) => r.format === format && r.language === "en",
    );
    if (hit) {
      found("render", `${format} (${hit.file_hash.slice(0, 12)}…)`);
      continue;
    }
    const produced = await sessions.reviewer.post(
      `/api/revisions/${revision.id}/render`,
      { format, language: "en" },
    );
    made(
      "render",
      `${format} — ${produced.render.file_name}, ${produced.size_bytes} bytes, ` +
        `coverage ${produced.render.coverage_claim}`,
    );
  }

  // ── 11. the second company: a draft with real findings ───────────────────
  step("11. Second company — a draft revision with real validation findings");
  const midAdmin = new Session(MIDFLOW_ADMIN.role);
  const midCreated = await ensureAccount(midAdmin, {
    email: MIDFLOW_ADMIN.email,
    password: role.password,
    name: MIDFLOW_ADMIN.name,
  });
  if (midCreated.created) made("account", MIDFLOW_ADMIN.email);
  else found("account", MIDFLOW_ADMIN.email);
  const midCompany = await ensureOwnedCompany(midAdmin, MIDFLOW_COMPANY);
  await ensureMembership(midCompany.id, MIDFLOW_ADMIN.email, "esg_admin");
  await ensureAccount(midAdmin, {
    email: MIDFLOW_ADMIN.email,
    password: role.password,
    name: MIDFLOW_ADMIN.name,
  });
  await ensureCompanyProfile(midAdmin, {
    industry: "Textile manufacturing",
    country: "Slovenia",
    nace_code: "13.92",
    headcount: 21,
    currency: "EUR",
  });

  const midEntity = await ensureRow(midAdmin, {
    kind: "legal entity",
    listPath: "/api/org/entities",
    listKey: "entities",
    match: (e) => e.organisation_name === MIDFLOW_COMPANY,
    create: {
      __label: MIDFLOW_COMPANY,
      organisation_name: MIDFLOW_COMPANY,
      registration_number: "SI-3388120000",
      registered_address: "Obala 114, 6320 Portorož, Slovenia",
      country: "SI",
      nace_code: "13.92",
      reporting_currency: "EUR",
      employee_count: 21,
      average_fte: 19.4,
      turnover: 2300000,
      group_structure_type: "standalone",
      effective_from: "2014-02-03",
    },
  });
  const midFacility = await ensureRow(midAdmin, {
    kind: "facility",
    listPath: "/api/org/facilities",
    listKey: "facilities",
    match: (f) => f.facility_name === "Portorož Weaving Mill",
    create: {
      __label: "Portorož Weaving Mill",
      facility_name: "Portorož Weaving Mill",
      legal_entity_id: midEntity.id,
      facility_type: "plant",
      address: "Obala 114, 6320 Portorož",
      postal_code: "6320",
      country: "SI",
      tenure: "owned",
      control_status: "controlled",
      floor_area: 3100,
      opening_date: "2014-02-03",
      included_in_boundary: true,
      boundary_classification: "scope_1_2",
    },
  });
  const midPeriod = await ensureRow(midAdmin, {
    kind: "period",
    listPath: "/api/periods",
    listKey: "periods",
    match: (p) => p.period_name === "FY2024",
    create: {
      __label: "FY2024",
      period_name: "FY2024",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      reporting_year: 2024,
    },
  });
  const midBoundary = await midAdmin.get(`/api/periods/${midPeriod.id}/scope`);
  if (midBoundary.entries.length === 0) {
    await midAdmin.put(`/api/periods/${midPeriod.id}/scope`, {
      entries: [{ legal_entity_id: midEntity.id, status: "included" }],
    });
    made("boundary", "1 entity included");
  } else found("boundary", "1 entity included");

  const midRevisions = await midAdmin.get(
    `/api/periods/${midPeriod.id}/revisions`,
  );
  let midRevision = midRevisions.revisions.find((r) => r.is_current);
  if (midRevision)
    found("revision", `no.${midRevision.revision_no} (${midRevision.status})`);
  else {
    midRevision = await midAdmin.post(
      `/api/periods/${midPeriod.id}/revisions`,
      {},
    );
    made("revision", `no.${midRevision.revision_no} (${midRevision.status})`);
  }

  /**
   * DELIBERATE FINDINGS, so `/review` has something real to show.
   *
   * They cannot be faked, and that constraint shapes what they are: every write
   * path runs its own scope's rules inside the transaction and ROLLS BACK on a
   * blocking failure (VR-3), so a row that violates a blocking `record` rule
   * simply cannot be created — `POST /api/activities/emission` answers 422 with
   * the rule. What CAN exist is the state a half-worked draft is actually in:
   *
   *   • VAL-041 (BLOCKING, revision) — an evidence hole. The rows carry no
   *     evidence link and their auto pre-filled DQ tier (`medium_calculated`)
   *     CLAIMS a source, so AC-7 refuses to let the revision be approved until
   *     somebody either attaches the invoice or downgrades the tier and says
   *     why. This is the single most common real reason an approval is refused.
   *     NOTE THE REVISION IS LEFT IN `in_review`, NOT IN `draft`: VAL-041 is
   *     deliberately silent while the inputs are still editable ("a gate, not a
   *     nag"), so no draft revision can carry a stored blocking failure at all.
   *     `in_review` is where a mid-flow report with a blocker actually sits.
   *   • VAL-040 (WARNING, revision) — the same person entered the rows and
   *     approved them. This company has one member, so it is true, and saying
   *     so is the whole point of a segregation-of-duties warning.
   *   • VAL-038 (WARNING, record) — the four pedigree scores are still null on
   *     every assessment. It never blocks anything.
   *   • VAL-012 (WARNING, record) — one row is dated November 2023 inside an
   *     FY2024 revision, a delivery note carried over from the previous year.
   *
   * Together they are exactly what `/review` exists to show: one thing that
   * must be fixed before approval, and several worth a second look.
   *
   * The rows themselves are deliberately NOT given evidence or DQ scores here —
   * that omission IS the demo.
   */
  const midPlan = [
    {
      id: (r) => r.source_name === "Dye-house boiler",
      body: {
        revision_id: midRevision.id,
        legal_entity_id: midEntity.id,
        facility_id: midFacility.id,
        activity_category: "stationary_combustion",
        source_name: "Dye-house boiler",
        activity_type: "natural_gas",
        activity_value: 58400,
        method: "fuel_based",
        unit: "kWh_gross",
        year_month: "2024-02",
        notes: "Metered gross volume from the February invoice.",
      },
    },
    {
      // No facility, but a documented exception in `notes` — which is exactly
      // what VAL-104 asks for, and what the screen shows as the AC-2 case.
      id: (r) => r.source_name === "Unallocated LPG cylinders",
      body: {
        revision_id: midRevision.id,
        legal_entity_id: midEntity.id,
        activity_category: "stationary_combustion",
        source_name: "Unallocated LPG cylinders",
        activity_type: "lpg",
        activity_value: 940,
        method: "fuel_based",
        unit: "kg",
        year_month: "2024-03",
        notes:
          "Cylinders delivered to the yard by the supplier; no site meter — documented exception, allocation to be resolved.",
      },
    },
    {
      // VAL-012: dated before the period it was filed under.
      id: (r) => r.source_name === "Standby generator (mis-dated)",
      body: {
        revision_id: midRevision.id,
        legal_entity_id: midEntity.id,
        facility_id: midFacility.id,
        activity_category: "stationary_combustion",
        source_name: "Standby generator (mis-dated)",
        activity_type: "gas_oil",
        activity_value: 310,
        method: "fuel_based",
        unit: "L",
        year_month: "2023-11",
        notes:
          "Delivery note carried over from the previous year — date to be checked.",
      },
    },
  ];
  const midMutable =
    midRevision.status === "draft" || midRevision.status === "rejected";
  if (midMutable) {
    const midExisting = await loadRows(midAdmin, "emission", midRevision.id);
    let midCreated2 = 0;
    for (const entry of midPlan) {
      if (!midExisting.find(entry.id)) {
        await midAdmin.post("/api/activities/emission", entry.body);
        midCreated2++;
      }
    }
    if (midCreated2)
      made(
        "input rows",
        `${midCreated2} created, without evidence or DQ scores (deliberately)`,
      );
    else found("input rows", `${midPlan.length} already present`);

    // Approved by the same account that entered them — which is what VAL-040
    // reports, and what this company (one member) genuinely does.
    let midApproved = 0;
    for (const row of await loadRows(midAdmin, "emission", midRevision.id)) {
      if (row.state === "approved") continue;
      await midAdmin.post(`/api/activities/emission/${row.id}/approve`);
      midApproved++;
    }
    if (midApproved)
      made("row approvals", `${midApproved} (by their own author)`);
  } else {
    found(
      "input rows",
      `${midPlan.length} (revision is ${midRevision.status}, frozen)`,
    );
  }

  // Record-scope rules judge one object each: the row for VAL-012/VAL-104, the
  // ASSESSMENT for VAL-038 — so both ids have to be handed over by name.
  for (const row of await loadRows(midAdmin, "emission", midRevision.id)) {
    await midAdmin.post("/api/validation/run", {
      scope: "record",
      targetId: row.id,
    });
    const dq = await midAdmin.get(`/api/dq/emission_activity/${row.id}`);
    if (dq.assessment) {
      await midAdmin.post("/api/validation/run", {
        scope: "record",
        targetId: dq.assessment.id,
      });
    }
  }
  for (const [scope, target] of [
    ["reference_org", midEntity.id],
    ["period", midPeriod.id],
    ["revision", midRevision.id],
  ]) {
    await midAdmin.post("/api/validation/run", { scope, targetId: target });
  }

  // Hand it to review, and stop there. `submit` and `start_review` both pass
  // (VAL-041 says nothing about a draft); `approve` is where the evidence hole
  // stops it, which is the refusal a demo-er should click into.
  await advanceRevision(midRevision.id, "in_review", {
    read: midAdmin,
    submit: midAdmin,
    review: midAdmin,
    approve: midAdmin,
  });
  await midAdmin.post("/api/validation/run", {
    scope: "revision",
    targetId: midRevision.id,
  });

  const midFindings = await midAdmin.get(
    `/api/revisions/${midRevision.id}/validation`,
  );
  const blocking = midFindings.results.filter((r) => r.blocking && !r.passed);
  const warnings = midFindings.results.filter(
    (r) => !r.passed && r.severity === "warning",
  );
  note(
    `stored findings: ${blocking.length} blocking (${[...new Set(blocking.map((r) => r.ruleCode))].join(", ") || "none"}), ` +
      `${warnings.length} warning (${[...new Set(warnings.map((r) => r.ruleCode))].join(", ") || "none"})`,
  );
  const codes = new Set(
    midFindings.results.filter((r) => !r.passed).map((r) => r.ruleCode),
  );
  if (!codes.has("VAL-041") || warnings.length === 0) {
    fail(
      "the second company was supposed to end up with VAL-041 (blocking) and at " +
        `least one warning on its revision; got ${[...codes].join(", ") || "nothing"}. ` +
        "/review would have nothing to show.",
    );
  }

  // ── summary ──────────────────────────────────────────────────────────────
  step("Summary");
  console.log(`   created : ${tally.created.length} things`);
  console.log(
    `   existing: ${tally.existing.length} things were already there`,
  );
  console.log("");
  console.log(`   Demo at ${BASE_URL}`);
  console.log("");
  console.log(
    `   ${SHOWCASE_COMPANY} — the finished report (period FY2025, revision locked,`,
  );
  console.log(
    "   one calculation run, a PDF and an XLSX render). Sign in as each of:",
  );
  for (const member of SHOWCASE_MEMBERS) {
    console.log(`     ${member.role.padEnd(12)} ${member.email}`);
  }
  console.log(`   password: from ${role.source}`);
  console.log("");
  console.log(
    `   ${MIDFLOW_COMPANY} — a revision in review, blocked by VAL-041 and carrying`,
  );
  console.log(
    "   VAL-038 / VAL-040 warnings. Press Approve on /review to see it refused:",
  );
  console.log(`     esg_admin    ${MIDFLOW_ADMIN.email}   (same password)`);
  console.log("");
  if (prodAccounts.length) {
    console.log(
      `   ${prodAccounts.length} production accounts, each with its own company —`,
    );
    console.log(`   credentials in ${PROD_USERS_FILE}`);
    console.log("");
  }
  console.log("   Click-through: /dashboard → /organisation → /inventory →");
  console.log("   /inventory/disclosures → /evidence → /review → /reports");
  console.log(
    "   Then sign in as the auditor and as the contributor and compare the sidebar.",
  );
  for (const advisory of advisories) {
    console.log("");
    console.log(`   ! ${advisory}`);
  }
}

main()
  .then(async () => {
    await sql.end();
    console.log("\ndemo-seed: done.");
  })
  .catch(async (error) => {
    console.error(`\ndemo-seed: FAILED at step "${currentStep}"`);
    console.error(`demo-seed: ${error?.message ?? error}`);
    if (!(error instanceof SeedError) && error?.stack)
      console.error(error.stack);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
