import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import worker, { testables } from "../src/worker.js";

const validForm = {
  Anrede: "Frau",
  Vorname: "TECHNISCHER TEST",
  Nachname: "NICHT BEARBEITEN",
  "E-Mail": "qa-test@example.com",
  Telefon: "+49 123 456",
  Nachricht: "TEST - Geseke dashboard - 2026-09-16T00:00:00Z",
  "Einwilligung akzeptiert": "Ja",
  Formularquelle: "Kontaktformular Wohnquartier Geseke West",
  Formularseite: "https://example.com/#kontakt",
  Zusatzfeld: "Zusatzwert",
  _cc: "must-not-be-stored@example.com",
};

class WebhookDatabase {
  constructor() { this.keys = new Set(); this.rows = []; }
  prepare(sql) {
    return {
      bind: (...values) => ({
        run: async () => {
          if (!sql.includes("INSERT OR IGNORE INTO submissions")) return { meta: { changes: 0 } };
          const key = values[14];
          if (this.keys.has(key)) return { meta: { changes: 0 } };
          this.keys.add(key);
          this.rows.push(values);
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

class RaceDatabase {
  constructor() {
    this.rows = [this.row(1, "initial")];
    this.insertedDuringLoad = false;
  }

  row(sequence, label) {
    return {
      sequence,
      id: `${String(sequence).padStart(8, "0")}-0000-4000-8000-000000000000`,
      received_at: `2026-09-16T00:00:0${sequence}.000Z`,
      status: "new",
      first_name: "TECHNISCHER",
      last_name: label.toUpperCase(),
      email: `${label}@example.com`,
      telephone: "",
      message: label,
      source: "race-test",
    };
  }

  prepare(sql) {
    const database = this;
    const statement = {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes("MAX(sequence)")) return { boundary: Math.max(0, ...database.rows.map((row) => row.sequence)) };
        return null;
      },
      async all() {
        if (sql.includes("sequence <= ?")) {
          const boundary = this.values[0];
          // This is the critical race: a webhook commits after MAX(sequence)
          // was read, but before the initial SELECT returns.
          if (!database.insertedDuringLoad) {
            database.rows.push(database.row(2, "arrived-during-load"));
            database.insertedDuringLoad = true;
          }
          return { results: database.rows.filter((row) => row.sequence <= boundary) };
        }
        if (sql.includes("sequence > ?")) {
          const boundary = this.values[0];
          return { results: database.rows.filter((row) => row.sequence > boundary) };
        }
        return { results: [] };
      },
    };
    return statement;
  }
}

function envWith(db) {
  return { LEADS_DB: db, ASSETS: { fetch: () => new Response("asset") } };
}

test("maps the repository's exact German fields", () => {
  const lead = testables.normalizeLead(validForm);
  assert.equal(lead.firstName, "TECHNISCHER TEST");
  assert.equal(lead.lastName, "NICHT BEARBEITEN");
  assert.equal(lead.consent, "Ja");
  assert.equal(lead.extraFields.Zusatzfeld, "Zusatzwert");
});

test("extracts FormSubmit's production JSON-string form_data payload", () => {
  const payload = { form_data: JSON.stringify(validForm) };
  assert.deepEqual(testables.extractWebhookFormData(payload), validForm);
  assert.deepEqual(testables.extractWebhookFormData({ form_data: validForm }), validForm);
});

test("rejects incomplete or invalid lead data", () => {
  assert.equal(testables.normalizeLead({ ...validForm, "E-Mail": "invalid" }), null);
  assert.equal(testables.normalizeLead({ ...validForm, Nachricht: "" }), null);
});

test("removes FormSubmit infrastructure fields from stored raw payload", () => {
  const clean = testables.sanitizePayload(validForm);
  assert.equal(clean._cc, undefined);
  assert.equal(clean.Vorname, "TECHNISCHER TEST");
});

test("cursor round-trips without exposing SQL state", () => {
  const cursor = testables.encodeCursor("2026-09-16T00:00:00.000Z", "123");
  assert.deepEqual(testables.decodeCursor(cursor), { receivedAt: "2026-09-16T00:00:00.000Z", id: "123" });
  assert.equal(testables.decodeCursor("invalid"), null);
  const syncCursor = testables.encodeSyncCursor(42);
  assert.equal(testables.decodeSyncCursor(syncCursor), 42);
  assert.equal(testables.decodeSyncCursor("invalid"), null);
});

test("initial sequence boundary cannot miss a submission arriving during loading", async () => {
  const database = new RaceDatabase();
  const initialResponse = await testables.listSubmissions(new URL("https://example.com/api/admin/submissions"), envWith(database));
  const initial = await initialResponse.json();

  assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0].message, "initial");
  assert.equal(testables.decodeSyncCursor(initial.syncCursor), 1);

  const updateResponse = await testables.submissionUpdates(
    new URL(`https://example.com/api/admin/submissions/updates?after=${encodeURIComponent(initial.syncCursor)}`),
    envWith(database),
  );
  const updates = await updateResponse.json();

  assert.equal(updates.items.length, 1);
  assert.equal(updates.items[0].message, "arrived-during-load");
  assert.equal(updates.items[0].sequence, 2);
  assert.equal(testables.decodeSyncCursor(updates.cursor), 2);
});

test("node:crypto PBKDF2 verifier accepts a generated hash only for the correct password", async () => {
  const password = "local-test-password";
  const salt = randomBytes(16);
  const iterations = 100_000;
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const encoded = `pbkdf2-sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
  assert.equal(await testables.verifyPassword(password, encoded), true);
  assert.equal(await testables.verifyPassword("wrong", encoded), false);
});

test("webhook inserts one row and suppresses an identical retry", async () => {
  const db = new WebhookDatabase();
  const makeRequest = () => new Request("https://example.com/api/webhooks/formsubmit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ form_data: validForm }),
  });
  const first = await worker.fetch(makeRequest(), envWith(db));
  const second = await worker.fetch(makeRequest(), envWith(db));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).stored, true);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(db.rows.length, 1);
});

test("unauthenticated lead API never returns data", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/admin/submissions"), envWith(new WebhookDatabase()));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Nicht angemeldet." });
});

test("public form preserves recipients and adds only approved routing fields", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /action="https:\/\/formsubmit\.co\/alexander\.laumeier@sparkasse-geseke\.de"/);
  assert.match(html, /name="_cc" value="immobilien@sparkasse-geseke\.de"/);
  assert.match(html, /name="_webhook" value="https:\/\/wohnen\.wohnquartier-geseke-west\.de\/api\/webhooks\/formsubmit"/);
  assert.match(html, /name="Formularquelle"/);
  assert.match(html, /name="Formularseite"/);
});

test("dashboard renders untrusted values using textContent, never innerHTML", async () => {
  const script = await readFile(new URL("../admin/admin.js", import.meta.url), "utf8");
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML/);
});
