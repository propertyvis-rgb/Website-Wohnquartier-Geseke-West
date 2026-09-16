const loginPanel = document.querySelector("[data-login-panel]");
const loginForm = document.querySelector("[data-login-form]");
const loginError = document.querySelector("[data-login-error]");
const inbox = document.querySelector("[data-inbox]");
const filters = document.querySelector("[data-filters]");
const leadList = document.querySelector("[data-lead-list]");
const emptyState = document.querySelector("[data-empty]");
const loadMore = document.querySelector("[data-load-more]");
const logoutButton = document.querySelector("[data-logout]");
const newCount = document.querySelector("[data-new-count]");
const connectionNote = document.querySelector("[data-connection-note]");
const dialog = document.querySelector("[data-dialog]");
const detailName = document.querySelector("[data-detail-name]");
const detailList = document.querySelector("[data-detail-list]");
const statusToggle = document.querySelector("[data-status-toggle]");
const deleteButton = document.querySelector("[data-delete]");

const state = {
  items: new Map(),
  nextCursor: null,
  syncCursor: null,
  pollTimer: null,
  currentId: null,
  unseen: 0,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Die Anfrage konnte nicht verarbeitet werden.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function initialize() {
  try {
    await api("/api/admin/session");
    showInbox();
    await loadSubmissions();
  } catch {
    showLogin();
  }
}

function showLogin() {
  stopPolling();
  inbox.hidden = true;
  loginPanel.hidden = false;
  document.querySelector("#password")?.focus();
}

function showInbox() {
  loginPanel.hidden = true;
  inbox.hidden = false;
  startPolling();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: new FormData(loginForm).get("password") }),
    });
    loginForm.reset();
    showInbox();
    await loadSubmissions();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  try { await api("/api/admin/logout", { method: "POST" }); } finally { showLogin(); }
});

filters.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadSubmissions();
});

loadMore.addEventListener("click", () => loadSubmissions({ append: true }));
document.querySelector("[data-dialog-close]").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

statusToggle.addEventListener("click", async () => {
  const item = state.items.get(state.currentId);
  if (!item) return;
  const status = item.status === "new" ? "processed" : "new";
  await api(`/api/admin/submissions/${item.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  item.status = status;
  renderRows();
  await openDetail(item.id);
});

deleteButton.addEventListener("click", async () => {
  const item = state.items.get(state.currentId);
  if (!item || !window.confirm("Diese Anfrage wirklich dauerhaft löschen?")) return;
  await api(`/api/admin/submissions/${item.id}`, { method: "DELETE" });
  state.items.delete(item.id);
  dialog.close();
  renderRows();
});

async function loadSubmissions({ append = false } = {}) {
  const params = new URLSearchParams(new FormData(filters));
  if (append && state.nextCursor) params.set("cursor", state.nextCursor);
  try {
    const data = await api(`/api/admin/submissions?${params}`);
    if (!append) state.items.clear();
    data.items.forEach((item) => state.items.set(item.id, item));
    state.nextCursor = data.nextCursor;
    if (!append) state.syncCursor = data.syncCursor;
    loadMore.hidden = !state.nextCursor;
    renderRows();
    connectionNote.textContent = "Neue Anfragen erscheinen automatisch.";
  } catch (error) {
    if (error.status === 401) return showLogin();
    connectionNote.textContent = error.message;
  }
}

function renderRows(arrivalIds = new Set()) {
  const items = [...state.items.values()].sort((left, right) =>
    right.received_at.localeCompare(left.received_at) || right.id.localeCompare(left.id));
  leadList.replaceChildren(...items.map((item) => createRow(item, arrivalIds.has(item.id))));
  emptyState.hidden = items.length > 0;
}

function createRow(item, isArrival) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `lead-row${isArrival ? " is-new-arrival" : ""}`;
  row.addEventListener("click", () => openDetail(item.id));
  row.append(
    cell("lead-date", formatDate(item.received_at)),
    cell("lead-name", `${item.first_name} ${item.last_name}`),
    cell("lead-email", item.email),
    cell(`status ${item.status === "processed" ? "processed" : ""}`, item.status === "new" ? "Neu" : "Bearbeitet"),
  );
  return row;
}

function cell(className, value) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = value;
  return element;
}

async function openDetail(id) {
  try {
    const { item } = await api(`/api/admin/submissions/${id}`);
    state.currentId = id;
    state.items.set(id, { ...state.items.get(id), ...item });
    detailName.textContent = `${item.first_name} ${item.last_name}`;
    const fields = [
      ["Eingegangen", formatDate(item.received_at)], ["Status", item.status === "new" ? "Neu" : "Bearbeitet"],
      ["Anrede", item.salutation], ["Vorname", item.first_name], ["Nachname", item.last_name],
      ["E-Mail", item.email], ["Telefon", item.telephone], ["Nachricht", item.message],
      ["Einwilligung", item.consent], ["Quelle", item.source], ["Formularseite", item.page_url],
      ...Object.entries(item.extra_fields || {}),
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");
    detailList.replaceChildren(...fields.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      return [term, description];
    }));
    statusToggle.textContent = item.status === "new" ? "Als bearbeitet markieren" : "Als neu markieren";
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    connectionNote.textContent = error.message;
  }
}

function startPolling() {
  stopPolling();
  if (!document.hidden) state.pollTimer = window.setInterval(pollUpdates, 9000);
}

function stopPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollUpdates() {
  if (document.hidden || !state.syncCursor) return;
  try {
    const data = await api(`/api/admin/submissions/updates?after=${encodeURIComponent(state.syncCursor)}`);
    state.syncCursor = data.cursor;
    const arrivals = new Set();
    for (const item of data.items) {
      if (!state.items.has(item.id) && matchesActiveFilters(item)) {
        state.items.set(item.id, item);
        arrivals.add(item.id);
      }
    }
    if (arrivals.size) {
      state.unseen += arrivals.size;
      newCount.textContent = String(state.unseen);
      newCount.hidden = false;
      renderRows(arrivals);
      connectionNote.textContent = `${arrivals.size} neue Anfrage${arrivals.size === 1 ? "" : "n"} eingegangen.`;
    }
  } catch (error) {
    if (error.status === 401) showLogin();
    else connectionNote.textContent = "Verbindung wird beim nächsten Intervall erneut geprüft.";
  }
}

function matchesActiveFilters(item) {
  const values = Object.fromEntries(new FormData(filters));
  if (values.status !== "all" && item.status !== values.status) return false;
  const day = item.received_at.slice(0, 10);
  if (values.from && day < values.from) return false;
  if (values.to && day > values.to) return false;
  if (values.q) {
    const haystack = `${item.first_name} ${item.last_name} ${item.email} ${item.telephone || ""} ${item.message || ""}`.toLocaleLowerCase("de");
    if (!haystack.includes(values.q.toLocaleLowerCase("de").trim())) return false;
  }
  return true;
}

document.addEventListener("visibilitychange", () => {
  if (inbox.hidden) return;
  if (document.hidden) stopPolling();
  else { pollUpdates(); startPolling(); }
});

window.addEventListener("focus", () => {
  if (!inbox.hidden && !document.hidden) pollUpdates();
});

function formatDate(value) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

initialize();
