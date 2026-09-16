const SESSION_COOKIE = "geseke_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 8;
const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const STATUSES = new Set(["new", "processed"]);

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      console.error("Unhandled request error", error);
      return json({ error: "Interner Fehler." }, 500);
    }
  },
};

async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/webhooks/formsubmit") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return receiveWebhook(request, env);
  }

  if (url.pathname === "/api/admin/login") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return login(request, env);
  }

  if (url.pathname === "/api/admin/logout") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    if (!validOrigin(request)) return json({ error: "Ungültige Anfrage." }, 403);
    await env.LEADS_DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(session.tokenHash).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (url.pathname === "/api/admin/session") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    return json({ authenticated: true });
  }

  if (url.pathname === "/api/admin/submissions" && request.method === "GET") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    return listSubmissions(url, env);
  }

  if (url.pathname === "/api/admin/submissions/updates" && request.method === "GET") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    return submissionUpdates(url, env);
  }

  const submissionMatch = url.pathname.match(/^\/api\/admin\/submissions\/([0-9a-f-]{36})$/i);
  if (submissionMatch) {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const id = submissionMatch[1];
    if (request.method === "GET") return getSubmission(id, env);
    if (!validOrigin(request)) return json({ error: "Ungültige Anfrage." }, 403);
    if (request.method === "PATCH") return updateSubmission(request, id, env);
    if (request.method === "DELETE") return deleteSubmission(id, env);
    return methodNotAllowed("GET, PATCH, DELETE");
  }

  if (url.pathname.startsWith("/api/")) return json({ error: "Nicht gefunden." }, 404);
  return env.ASSETS.fetch(request);
}

async function receiveWebhook(request, env) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "Payload zu groß." }, 413);

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) return json({ error: "Payload zu groß." }, 413);

  let payload;
  try {
    payload = parseWebhookBody(bodyText, request.headers.get("content-type") || "");
  } catch {
    return json({ error: "Ungültiger Payload." }, 400);
  }

  const formData = payload?.form_data && typeof payload.form_data === "object" ? payload.form_data : payload;
  const lead = normalizeLead(formData);
  if (!lead) return json({ error: "Erforderliche Felder fehlen." }, 422);

  const now = new Date();
  const receivedAt = now.toISOString();
  const sanitizedPayload = sanitizePayload(formData);
  const canonicalPayload = stableStringify(sanitizedPayload);
  const payloadHash = await sha256(canonicalPayload);
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const dedupeKey = await sha256(`${payloadHash}:${hourBucket}`);
  const id = crypto.randomUUID();

  const result = await env.LEADS_DB.prepare(`
    INSERT OR IGNORE INTO submissions (
      id, received_at, status, salutation, first_name, last_name, email, telephone,
      message, consent, source, page_url, extra_fields_json, raw_payload,
      payload_hash, dedupe_key, created_at, updated_at
    ) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, receivedAt, lead.salutation, lead.firstName, lead.lastName, lead.email,
    lead.telephone, lead.message, lead.consent, lead.source, lead.pageUrl,
    JSON.stringify(lead.extraFields), canonicalPayload, payloadHash, dedupeKey,
    receivedAt, receivedAt,
  ).run();

  const inserted = Number(result.meta?.changes || 0) === 1;
  return json({ ok: true, stored: inserted, duplicate: !inserted, id: inserted ? id : undefined });
}

async function login(request, env) {
  if (!validOrigin(request)) return json({ error: "Ungültige Anfrage." }, 403);
  if (!env.ADMIN_PASSWORD_HASH || !env.AUTH_RATE_LIMIT_SECRET) {
    return json({ error: "Anmeldung ist noch nicht konfiguriert." }, 503);
  }
  const identifier = await loginIdentifier(request, env.AUTH_RATE_LIMIT_SECRET);
  const limited = await recordLoginAttempt(identifier, env);
  if (limited) return json({ error: "Zu viele Anmeldeversuche. Bitte später erneut versuchen." }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  const valid = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!valid) return json({ error: "Passwort ist nicht korrekt." }, 401);

  await env.LEADS_DB.prepare("DELETE FROM auth_attempts WHERE identifier_hash = ?").bind(identifier).run();
  await env.LEADS_DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();

  const token = randomToken();
  const tokenHash = await sha256(token);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_MAX_AGE * 1000);
  await env.LEADS_DB.prepare(
    "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
  ).bind(tokenHash, createdAt.toISOString(), expiresAt.toISOString()).run();

  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function requireSession(request, env) {
  const token = readCookie(request.headers.get("cookie") || "", SESSION_COOKIE);
  if (!token) return json({ error: "Nicht angemeldet." }, 401);
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const session = await env.LEADS_DB.prepare(
    "SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?",
  ).bind(tokenHash, now).first();
  if (!session) return json({ error: "Sitzung abgelaufen." }, 401, { "Set-Cookie": clearSessionCookie() });
  return { tokenHash };
}

async function listSubmissions(url, env) {
  // Establish the database boundary before reading any rows. Inserts committed
  // after this point receive a higher sequence and are returned by /updates.
  const boundaryRow = await env.LEADS_DB.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS boundary FROM submissions",
  ).first();
  const syncBoundary = Number(boundaryRow?.boundary || 0);
  const status = url.searchParams.get("status") || "all";
  const query = clean(url.searchParams.get("q"), 160);
  const from = validDate(url.searchParams.get("from"));
  const to = validDate(url.searchParams.get("to"), true);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const limit = 50;
  const conditions = ["sequence <= ?"];
  const bindings = [syncBoundary];

  if (status !== "all") {
    if (!STATUSES.has(status)) return json({ error: "Ungültiger Status." }, 400);
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (query) {
    conditions.push("(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR telephone LIKE ? OR message LIKE ?)");
    const pattern = `%${query}%`;
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (from) { conditions.push("received_at >= ?"); bindings.push(from); }
  if (to) { conditions.push("received_at <= ?"); bindings.push(to); }
  if (cursor) {
    conditions.push("(received_at < ? OR (received_at = ? AND id < ?))");
    bindings.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.LEADS_DB.prepare(`
    SELECT id, received_at, status, first_name, last_name, email, telephone, message, source
    FROM submissions ${where}
    ORDER BY received_at DESC, id DESC LIMIT ?
  `).bind(...bindings, limit + 1).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return json({
    items,
    nextCursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null,
    syncCursor: encodeSyncCursor(syncBoundary),
  });
}

async function submissionUpdates(url, env) {
  const syncBoundary = decodeSyncCursor(url.searchParams.get("after"));
  if (syncBoundary === null) return json({ error: "Ungültiger Cursor." }, 400);
  const result = await env.LEADS_DB.prepare(`
    SELECT sequence, id, received_at, status, first_name, last_name, email, telephone, message, source
    FROM submissions
    WHERE sequence > ?
    ORDER BY sequence ASC LIMIT 100
  `).bind(syncBoundary).all();
  const items = result.results || [];
  const last = items.at(-1);
  return json({
    items,
    cursor: last ? encodeSyncCursor(Number(last.sequence)) : url.searchParams.get("after"),
  });
}

async function getSubmission(id, env) {
  const item = await env.LEADS_DB.prepare(`
    SELECT id, received_at, status, salutation, first_name, last_name, email,
      telephone, message, consent, source, page_url, extra_fields_json, created_at, updated_at
    FROM submissions WHERE id = ?
  `).bind(id).first();
  if (!item) return json({ error: "Anfrage nicht gefunden." }, 404);
  item.extra_fields = safeJson(item.extra_fields_json, {});
  delete item.extra_fields_json;
  return json({ item });
}

async function updateSubmission(request, id, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  if (!STATUSES.has(body.status)) return json({ error: "Ungültiger Status." }, 400);
  const result = await env.LEADS_DB.prepare(
    "UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?",
  ).bind(body.status, new Date().toISOString(), id).run();
  if (Number(result.meta?.changes || 0) !== 1) return json({ error: "Anfrage nicht gefunden." }, 404);
  return json({ ok: true, status: body.status });
}

async function deleteSubmission(id, env) {
  const result = await env.LEADS_DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id).run();
  if (Number(result.meta?.changes || 0) !== 1) return json({ error: "Anfrage nicht gefunden." }, 404);
  return json({ ok: true });
}

function normalizeLead(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const firstName = clean(input.Vorname, 120);
  const lastName = clean(input.Nachname, 120);
  const email = clean(input["E-Mail"], 254);
  const message = clean(input.Nachricht, 10_000);
  if (!firstName || !lastName || !email || !message || !/^\S+@\S+\.\S+$/.test(email)) return null;

  const mapped = new Set([
    "Anrede", "Vorname", "Nachname", "E-Mail", "Telefon", "Nachricht",
    "Einwilligung akzeptiert", "Einwilligung_akzeptiert", "Formularquelle", "Formularseite",
  ]);
  const extraFields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!mapped.has(key) && !key.startsWith("_") && typeof value !== "object") {
      extraFields[clean(key, 120)] = clean(value, 2_000);
    }
  }
  return {
    salutation: clean(input.Anrede, 80), firstName, lastName, email,
    telephone: clean(input.Telefon, 80), message,
    consent: clean(input["Einwilligung akzeptiert"] ?? input.Einwilligung_akzeptiert, 80),
    source: clean(input.Formularquelle, 200) || "Kontaktformular Wohnquartier Geseke West",
    pageUrl: safeHttpUrl(input.Formularseite), extraFields,
  };
}

function sanitizePayload(input) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (key.startsWith("_")) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[clean(key, 120)] = clean(value, key === "Nachricht" ? 10_000 : 2_000);
    }
  }
  return output;
}

function parseWebhookBody(text, contentType) {
  if (contentType.includes("application/json")) return JSON.parse(text);
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return JSON.parse(text);
}

async function recordLoginAttempt(identifier, env) {
  const now = new Date();
  const existing = await env.LEADS_DB.prepare(
    "SELECT window_started_at, attempts FROM auth_attempts WHERE identifier_hash = ?",
  ).bind(identifier).first();
  const windowExpired = !existing || now.getTime() - new Date(existing.window_started_at).getTime() > LOGIN_WINDOW_SECONDS * 1000;
  if (windowExpired) {
    await env.LEADS_DB.prepare(`
      INSERT INTO auth_attempts (identifier_hash, window_started_at, attempts) VALUES (?, ?, 1)
      ON CONFLICT(identifier_hash) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = 1
    `).bind(identifier, now.toISOString()).run();
    return false;
  }
  if (existing.attempts >= LOGIN_MAX_ATTEMPTS) return true;
  await env.LEADS_DB.prepare("UPDATE auth_attempts SET attempts = attempts + 1 WHERE identifier_hash = ?").bind(identifier).run();
  return false;
}

async function loginIdentifier(request, secret) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return hex(signature);
}

async function verifyPassword(password, encoded) {
  const [scheme, iterationsText, saltText, hashText] = encoded.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 100_000 || !saltText || !hashText) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const expected = fromBase64(hashText);
    const actual = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(saltText), iterations }, key, expected.byteLength * 8);
    return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected));
  } catch { return false; }
}

function validOrigin(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function validDate(value, endOfDay = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const date = new Date(`${value}${suffix}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href.slice(0, 2_000) : "";
  } catch { return ""; }
}

function clean(value, maxLength) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function stableStringify(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(header, name) {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function encodeCursor(receivedAt, id) {
  return btoa(JSON.stringify({ receivedAt, id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const cursor = JSON.parse(atob(padded));
    if (!cursor.receivedAt || !cursor.id || Number.isNaN(new Date(cursor.receivedAt).getTime())) return null;
    return cursor;
  } catch { return null; }
}

function encodeSyncCursor(sequence) {
  return btoa(JSON.stringify({ sequence })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSyncCursor(value) {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const sequence = JSON.parse(atob(padded)).sequence;
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  } catch { return null; }
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function methodNotAllowed(allow) {
  return json({ error: "Methode nicht erlaubt." }, 405, { Allow: allow });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export const testables = {
  normalizeLead, sanitizePayload, stableStringify, encodeCursor, decodeCursor,
  encodeSyncCursor, decodeSyncCursor, verifyPassword, parseWebhookBody, readCookie,
  listSubmissions, submissionUpdates,
};
