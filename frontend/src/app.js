import { inferDateOrder, normalizeImportDate } from "./date.js";

/*
 * FRONTEND APPLICATION CONTROLLER
 * --------------------------------
 * This framework-free file holds temporary UI state, renders each view,
 * converts browser events into REST requests, and switches between the public
 * authentication screen and private application shell. Persistent financial
 * data never lives here; the Worker and D1 remain authoritative.
 */

// Remove a trailing slash once so every API route joins predictably.
const API = window.APP_CONFIG.API_BASE_URL.replace(/\/$/, "");
// Short-lived browser cache. A refresh intentionally reloads it from the API.
const state = {
  categories: [],
  accounts: [],
  masterCategories: [],
  categoryRules: [],
  categorySuggestions: [],
  transactions: [],
  page: 1,
  pageSize: 25,
  total: 0,
  csv: null,
  summary: null,
  activityMode: "expense",
  cashFlowData: null,
  cashFlowColorBy: "type",
  cashFlowSelections: { expense: new Set(), income: new Set() },
  cashFlowFiltersInitialized: false,
  selectedMasterCategoryId: null,
  activityTrendSelection: { kind: "all", id: null, label: "All expenses" },
  bulkEditMode: false,
  selectedTransactionIds: new Set(),
  lastSelectedTransactionIndex: null,
  netWorthTimeline: null,
  selectedNetWorthAccounts: new Set(),
  netWorthSelectionInitialized: false,
  selectedNetWorthSeries: "networth",
  balanceSnapshots: [],
  projectionRules: [],
  websiteColors: null,
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
});
const cents = (value) => Math.round(Number(value) * 100);
const dollars = (value) => Number(value ?? 0) / 100;
const parseMoney = (value) => {
  const text = String(value ?? "").trim();
  const negative = text.startsWith("-") || /^\(.*\)$/.test(text);
  const number = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? (negative ? -number : number) : NaN;
};
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const NAV_STORAGE_KEY = "rr-budget-nav-collapsed";
const PAGE_SESSION_KEY = "rr-budget-page-session";
const defaultWebsiteColors = {
  highlightColor: "#185b45",
  backgroundColor: "#f5f2e9",
  cardColor: "#fffdf7",
  textColor: "#16211d",
  positiveColor: "#185b45",
  negativeColor: "#a33b32",
  chartAccentColor: "#16211d",
};
const themePresets = {
  original: defaultWebsiteColors,
  forest: {
    ...defaultWebsiteColors,
    highlightColor: "#236b4e",
    backgroundColor: "#edf3e8",
    cardColor: "#fbfff8",
    positiveColor: "#26734f",
    chartAccentColor: "#123d2d",
  },
  ocean: {
    ...defaultWebsiteColors,
    highlightColor: "#176b87",
    backgroundColor: "#eaf4f7",
    cardColor: "#fbfeff",
    positiveColor: "#17765f",
    negativeColor: "#b04444",
    chartAccentColor: "#123f58",
  },
  contrast: {
    ...defaultWebsiteColors,
    highlightColor: "#0047ab",
    backgroundColor: "#ffffff",
    cardColor: "#ffffff",
    textColor: "#000000",
    positiveColor: "#006b35",
    negativeColor: "#b00020",
    chartAccentColor: "#000000",
  },
};
function applyWebsiteColors(colors) {
  const value = { ...defaultWebsiteColors, ...(colors ?? {}) };
  state.websiteColors = value;
  const root = document.documentElement.style;
  root.setProperty("--green", value.highlightColor);
  root.setProperty("--paper", value.backgroundColor);
  root.setProperty("--panel", value.cardColor);
  root.setProperty("--ink", value.textColor);
  root.setProperty("--positive", value.positiveColor);
  root.setProperty("--danger", value.negativeColor);
  root.setProperty("--chart-accent", value.chartAccentColor);
  const form = $("#website-colors-form");
  if (form)
    for (const [name, color] of Object.entries(value))
      if (form.elements[name]) form.elements[name].value = color;
}
function colorContrast(first, second) {
  const luminance = (hex) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)
      .map((part) => parseInt(part, 16) / 255);
    const [red, green, blue] = channels.map((value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
async function loadWebsiteColors() {
  const result = await api("/api/v1/website-preferences");
  applyWebsiteColors(result.data);
}
const pageSessionKey = () => {
  try {
    return window.sessionStorage.getItem(PAGE_SESSION_KEY);
  } catch {
    return null;
  }
};
const mobileNavigation = () => window.matchMedia("(max-width: 800px)").matches;
function setMobileNavigation(open) {
  document.body.classList.toggle("nav-open", open);
  $("#mobile-nav-toggle")?.setAttribute("aria-expanded", String(open));
  if ($("#sidebar-backdrop")) $("#sidebar-backdrop").hidden = !open;
}
function setNavigationCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  const toggle = $("#nav-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute(
      "aria-label",
      collapsed ? "Expand navigation" : "Collapse navigation",
    );
  }
}

// Central HTTP helper. In production, /api is handled by a same-origin Pages
// Function that securely relays requests to the dedicated API Worker. This
// allows mobile browsers to use the HttpOnly session cookie reliably.
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(pageSessionKey() ? { "x-page-session": pageSessionKey() } : {}),
        ...options.headers,
      },
    });
  } catch (cause) {
    // Fetch only rejects when no HTTP response was available. Give local users
    // the terminal hint, while production users get deployment-oriented advice.
    const recovery = ["localhost", "127.0.0.1"].includes(
      window.location.hostname,
    )
      ? "Make sure the Worker PowerShell window is still running, then try again."
      : "The deployed Worker may be unavailable or may not allow this Pages address.";
    throw new Error(`Cannot reach the budget API at ${API}. ${recovery}`, {
      cause,
    });
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({
    error: { message: "The server returned an unreadable response." },
  }));
  if (!response.ok) {
    const error = new Error(
      `${
        payload.error?.details
          ?.map((item) => `${item.field}: ${item.message}`)
          .join(" ") ||
        payload.error?.message ||
        "Request failed."
      }${payload.error?.code ? ` [${payload.error.code}]` : ""}${payload.error?.requestId ? ` Request ID: ${payload.error.requestId}` : ""}`,
    );
    error.status = response.status;
    error.code = payload.error?.code;
    if (
      response.status === 401 &&
      !path.includes("/auth/login") &&
      !path.includes("/auth/register")
    ) {
      try {
        window.sessionStorage.removeItem(PAGE_SESSION_KEY);
      } catch {
        // Private browsing can disable storage; the server still rejects access.
      }
      showAuth(error.message);
    }
    throw error;
  }
  return payload;
}

// Swap the private application for the sign-in card and display safe errors.
function showAuth(error = "") {
  setMobileNavigation(false);
  $("#auth-screen").hidden = false;
  $$(".app-shell").forEach((element) => (element.hidden = true));
  $("#auth-error").textContent = error;
  $("#auth-error").hidden = !error;
}

// Populate user-owned reference data before rendering the first private view.
async function enterApp(user) {
  $("#auth-screen").hidden = true;
  $$(".app-shell").forEach((element) => (element.hidden = false));
  $("#current-username").textContent = user.username;
  let collapsed = false;
  try {
    collapsed = window.localStorage.getItem(NAV_STORAGE_KEY) === "true";
  } catch {
    // Storage can be unavailable in private modes; the expanded menu is safe.
  }
  setNavigationCollapsed(collapsed);
  await Promise.all([loadLookups(), loadWebsiteColors()]);
  await showView();
}
// Reusable, non-blocking status message for forms and background operations.
function notify(message, isError = false) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.style.background = isError ? "#a33b32" : "#16211d";
  notice.hidden = false;
  window.setTimeout(() => {
    notice.hidden = true;
  }, 4200);
}
async function run(action) {
  try {
    return await action();
  } catch (error) {
    notify(
      error instanceof Error ? error.message : "Something went wrong.",
      true,
    );
    return null;
  }
}

/* ---------- Dates and monetary formatting ---------- */
function today() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function yearStart() {
  return `${today().slice(0, 4)}-01-01`;
}
function monthStart() {
  return `${today().slice(0, 7)}-01`;
}
function shiftYears(date, years) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + years);
  return value.toISOString().slice(0, 10);
}
function tomorrow() {
  const value = new Date(`${today()}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
function optionList(items, selected = "") {
  return items
    .filter((item) => item.active !== 0)
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)}</option>`,
    )
    .join("");
}
function refreshSelects() {
  $$('select[name="categoryId"]').forEach((element) => {
    element.innerHTML = optionList(state.categories);
  });
  $$('select[name="accountId"]').forEach((element) => {
    element.innerHTML = optionList(state.accounts);
  });
  for (const name of ["fromAccountId", "toAccountId"]) {
    const select = $(`select[name="${name}"]`);
    if (select)
      select.innerHTML =
        '<option value="">Choose an account</option>' +
        optionList(state.accounts);
  }
  $("#bulk-account").innerHTML =
    '<option value="">No change</option>' + optionList(state.accounts);
  $("#bulk-category").innerHTML =
    '<option value="">No change</option>' + optionList(state.categories);
  $("#transaction-category-filter").innerHTML =
    '<option value="">All categories</option>' + optionList(state.categories);
  $("#transaction-account-filter").innerHTML =
    '<option value="">All accounts</option>' + optionList(state.accounts);
}
function refreshTransactionCategoryOptions(type, selected = "") {
  const kind = type === "refund" ? "expense" : type;
  const categories = state.categories.filter((item) => item.kind === kind);
  const select = $('#transaction-form select[name="categoryId"]');
  select.innerHTML = optionList(categories, selected);
}

async function loadLookups() {
  const [categories, accounts, masterCategories, categoryRules] =
    await Promise.all([
      api("/api/v1/categories"),
      api("/api/v1/accounts"),
      api("/api/v1/master-categories"),
      api("/api/v1/category-rules"),
    ]);
  state.categories = categories.data;
  state.accounts = accounts.data;
  state.masterCategories = masterCategories.data;
  state.categoryRules = categoryRules.data;
  refreshSelects();
  $("#categories-list").innerHTML = state.categories
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.name)} <small>(${escapeHtml(item.kind)})</small></span><span>${item.active ? `<select class="master-category-assignment" data-category-id="${escapeHtml(item.id)}"><option value="">Unassigned</option>${optionList(state.masterCategories, item.masterCategoryId)}</select> <button class="secondary danger archive" data-kind="categories" data-id="${escapeHtml(item.id)}">Archive</button>` : "<small>Archived</small>"}</span></li>`,
    )
    .join("");
  $("#accounts-list").innerHTML = state.accounts
    .map(
      (item) =>
        `<li><span><strong>${escapeHtml(item.name)}</strong> <small>(${escapeHtml(item.accountType)}, ${escapeHtml(item.liquidityClass ?? "liquid")})</small><br><small>Interest ${Number(item.annualInterestBps ?? 0) / 100}% · Payment ${money.format(dollars(item.paymentAmountMinor))} ${escapeHtml(item.paymentFrequency ?? "none")}</small></span><span>${item.active ? `<button class="secondary edit-account" data-id="${escapeHtml(item.id)}">Edit</button> <button class="secondary danger archive" data-kind="accounts" data-id="${escapeHtml(item.id)}">Archive</button>` : "<small>Archived</small>"}</span></li>`,
    )
    .join("");
  $("#master-categories-list").innerHTML = state.masterCategories
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.name)}</span>${item.active ? `<button class="secondary danger archive-master" data-id="${escapeHtml(item.id)}">Archive</button>` : "<small>Archived</small>"}</li>`,
    )
    .join("");
  $("#category-rules-list").innerHTML = state.categoryRules
    .map(
      (item) =>
        `<li><span>If description contains <strong>${escapeHtml(item.pattern)}</strong> → ${escapeHtml(item.categoryName)} <small>(priority ${item.priority})</small></span>${item.active ? `<button class="secondary danger archive-rule" data-id="${escapeHtml(item.id)}">Archive</button>` : "<small>Archived</small>"}</li>`,
    )
    .join("");
}
async function loadTransactions() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  const search = $("#transaction-search").value.trim(),
    vendor = $("#transaction-vendor-filter").value.trim(),
    categoryId = $("#transaction-category-filter").value,
    accountId = $("#transaction-account-filter").value,
    type = $("#transaction-type-filter").value;
  if ($("#transaction-start-date").value)
    params.set("startDate", $("#transaction-start-date").value);
  if ($("#transaction-end-date").value)
    params.set("endDate", $("#transaction-end-date").value);
  if (search) params.set("search", search);
  if (vendor) params.set("vendor", vendor);
  if (categoryId) params.set("categoryId", categoryId);
  if (accountId) params.set("accountId", accountId);
  if (type) params.set("type", type);
  params.set("sort", $("#transaction-sort").value);
  const result = await api(`/api/v1/transactions?${params}`);
  state.transactions = result.data;
  state.total = result.pagination.total;
  $("#transactions-body").innerHTML = state.transactions
    .map((item) => {
      const direction =
        item.transactionType === "refund"
          ? "credit"
          : (item.transactionDirection ?? "debit");
      const signedMinor =
        direction === "credit" ? item.amountMinor : -item.amountMinor;
      const selected = state.selectedTransactionIds.has(item.id);
      return `<tr class="transaction-${direction} ${selected ? "bulk-selected" : ""}" data-transaction-row="${escapeHtml(item.id)}"><td class="bulk-select-column" data-label="Select" ${state.bulkEditMode ? "" : "hidden"}><input class="transaction-select" type="checkbox" data-id="${escapeHtml(item.id)}" aria-label="Select ${escapeHtml(item.vendorName)}" ${selected ? "checked" : ""}/></td><td data-label="Date">${escapeHtml(item.transactionDate)}</td><td data-label="Vendor"><strong>${escapeHtml(item.vendorName)}</strong>${item.description ? `<br><small>${escapeHtml(item.description)}</small>` : ""}</td><td data-label="Category">${escapeHtml(item.categoryName)}</td><td data-label="Account">${escapeHtml(item.accountName)}</td><td data-label="Type"><span class="pill">${escapeHtml(item.transactionType)}</span></td><td data-label="Amount" class="money signed-amount">${signedMinor > 0 ? "+" : "−"}${money.format(Math.abs(dollars(signedMinor)))}</td><td data-label="Actions" class="transaction-actions"><button class="secondary edit-transaction" data-id="${escapeHtml(item.id)}">Edit</button> <button class="secondary danger delete-transaction" data-id="${escapeHtml(item.id)}">Delete</button></td></tr>`;
    })
    .join("");
  $("#transactions-empty").hidden = state.transactions.length > 0;
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $("#page-label").textContent = `Page ${state.page} of ${pages}`;
  $("#previous-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pages;
  updateBulkEditUi();
}
function updateBulkEditUi() {
  $("#bulk-edit-toolbar").hidden = !state.bulkEditMode;
  $("#bulk-edit-toggle").textContent = state.bulkEditMode
    ? "Editing multiple"
    : "Edit multiple";
  $("#bulk-selected-count").textContent = String(
    state.selectedTransactionIds.size,
  );
  $$(".bulk-select-column").forEach(
    (element) => (element.hidden = !state.bulkEditMode),
  );
  $("#apply-bulk-edit").disabled = !state.selectedTransactionIds.size;
  $("#delete-bulk-transactions").disabled = !state.selectedTransactionIds.size;
}
function setBulkEditMode(enabled) {
  state.bulkEditMode = enabled;
  if (!enabled) {
    state.selectedTransactionIds.clear();
    state.lastSelectedTransactionIndex = null;
    for (const select of ["#bulk-account", "#bulk-category", "#bulk-type"])
      $(select).value = "";
  }
  updateBulkEditUi();
  void loadTransactions();
}
function selectTransactionAt(index, checked, range = false) {
  if (range && state.lastSelectedTransactionIndex !== null) {
    const start = Math.min(state.lastSelectedTransactionIndex, index),
      end = Math.max(state.lastSelectedTransactionIndex, index);
    for (let cursor = start; cursor <= end; cursor += 1) {
      const id = state.transactions[cursor]?.id;
      if (id)
        checked
          ? state.selectedTransactionIds.add(id)
          : state.selectedTransactionIds.delete(id);
    }
  } else {
    const id = state.transactions[index]?.id;
    if (id)
      checked
        ? state.selectedTransactionIds.add(id)
        : state.selectedTransactionIds.delete(id);
  }
  state.lastSelectedTransactionIndex = index;
  void loadTransactions();
}
function currentTransactionFilters() {
  const params = new URLSearchParams();
  const search = $("#transaction-search").value.trim(),
    vendor = $("#transaction-vendor-filter").value.trim(),
    categoryId = $("#transaction-category-filter").value,
    accountId = $("#transaction-account-filter").value,
    type = $("#transaction-type-filter").value;
  if ($("#transaction-start-date").value)
    params.set("startDate", $("#transaction-start-date").value);
  if ($("#transaction-end-date").value)
    params.set("endDate", $("#transaction-end-date").value);
  if (search) params.set("search", search);
  if (vendor) params.set("vendor", vendor);
  if (categoryId) params.set("categoryId", categoryId);
  if (accountId) params.set("accountId", accountId);
  if (type) params.set("type", type);
  return params;
}
function drawBars(selector, rows) {
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.amountMinor)));
  $(selector).innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<button class="bar-row activity-account-row ${row.amountMinor < 0 ? "is-refund-total" : ""} ${state.activityTrendSelection.kind === "account" && state.activityTrendSelection.id === row.id ? "selected" : ""}" data-trend-account="${escapeHtml(row.id)}" data-trend-label="${escapeHtml(row.name)}" aria-pressed="${state.activityTrendSelection.kind === "account" && state.activityTrendSelection.id === row.id}"><span>${escapeHtml(row.name)}</span><progress class="bar-track" max="100" value="${(Math.abs(row.amountMinor) / max) * 100}" aria-label="${escapeHtml(row.name)} relative amount"></progress><strong>${money.format(dollars(row.amountMinor))}</strong></button>`,
        )
        .join("")
    : `<div class="empty">No ${state.activityMode} activity in this date range.</div>`;
}

const chartColors = [
  "#185b45",
  "#8aa32b",
  "#d79039",
  "#396f8f",
  "#91649b",
  "#bd5e50",
  "#4c8d77",
  "#a77d42",
  "#2563a6",
  "#b54773",
  "#6f7f2c",
  "#7a5d3b",
];
const masterKey = (value) => value || "unassigned";
const polarPoint = (angle, radius, center = 110) => ({
  x: center + Math.cos(angle - Math.PI / 2) * radius,
  y: center + Math.sin(angle - Math.PI / 2) * radius,
});
function donutPath(start, end) {
  const outerStart = polarPoint(start, 92),
    outerEnd = polarPoint(end, 92),
    innerEnd = polarPoint(end, 54),
    innerStart = polarPoint(start, 54),
    large = end - start > Math.PI ? 1 : 0;
  return `M${outerStart.x},${outerStart.y} A92,92 0 ${large},1 ${outerEnd.x},${outerEnd.y} L${innerEnd.x},${innerEnd.y} A54,54 0 ${large},0 ${innerStart.x},${innerStart.y} Z`;
}
function renderCategoryRanking() {
  const summary = state.summary,
    data = summary?.activity?.[state.activityMode];
  if (!data) return;
  const selected = state.selectedMasterCategoryId;
  const rows = data.byCategory
    .filter(
      (row) =>
        selected === null || masterKey(row.master_category_id) === selected,
    )
    .sort((a, b) => b.amount_minor - a.amount_minor);
  const master = data.byMasterCategory.find(
    (row) => masterKey(row.id) === selected,
  );
  $("#category-ranking-title").textContent = master
    ? `${master.name} categories`
    : selected === "unassigned"
      ? "Unassigned categories"
      : "All categories";
  $("#clear-master-filter").hidden = selected === null;
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.amount_minor)));
  $("#category-ranked-bars").innerHTML = rows.length
    ? rows
        .map((row, index) => {
          const periodBudget =
            Number(row.monthly_budget_minor ?? 0) * summary.monthCount;
          const remaining = periodBudget - row.amount_minor;
          const count = Number(row.transaction_count ?? 0);
          const average = count ? row.amount_minor / count : 0;
          const reversalMinor = Number(row.reversal_minor ?? 0);
          const selectedCategory =
            state.activityTrendSelection.kind === "category" &&
            state.activityTrendSelection.id === row.id;
          return `<article class="ranked-category-row ${row.amount_minor < 0 ? "is-refund-total" : ""} ${selectedCategory ? "selected" : ""}" data-trend-category="${escapeHtml(row.id)}" data-trend-label="${escapeHtml(row.name)}" tabindex="0" role="button" aria-pressed="${selectedCategory}"><span class="rank-number">${index + 1}</span><div class="ranked-category-main"><div class="ranked-category-label"><strong>${escapeHtml(row.name)}</strong><span>${money.format(dollars(row.amount_minor))}</span></div><progress class="ranked-track" max="100" value="${(Math.abs(row.amount_minor) / max) * 100}" aria-label="${escapeHtml(row.name)} relative amount"></progress></div><div class="category-tooltip" role="tooltip"><strong>${escapeHtml(row.name)}</strong><span>Net actual: ${money.format(dollars(row.amount_minor))}</span><span>${state.activityMode === "income" ? "Target" : "Budget"}: ${periodBudget ? money.format(dollars(periodBudget)) : "Not set"}</span><span>${periodBudget ? `${remaining < 0 ? "Over" : "Remaining"}: ${money.format(dollars(Math.abs(remaining)))}` : ""}</span><span>${count} transaction${count === 1 ? "" : "s"} · Average ${money.format(dollars(average))}</span><span>${reversalMinor ? `${state.activityMode === "expense" ? "Refunds" : "Reversals"}: ${money.format(dollars(reversalMinor))}` : `No ${state.activityMode === "expense" ? "refunds" : "reversals"} in this range`}</span></div></article>`;
        })
        .join("")
    : '<div class="empty">No categories belong to this master category in the selected range.</div>';
}
function renderSpendingBreakdown() {
  const summary = state.summary,
    data = summary?.activity?.[state.activityMode];
  if (!data) return;
  const rows = data.byMasterCategory.map((row) => ({
    ...row,
    key: masterKey(row.id),
    positiveMinor: Math.max(0, Number(row.amount_minor)),
  }));
  const total = rows.reduce((sum, row) => sum + row.positiveMinor, 0);
  let angle = 0;
  const paths = rows
    .filter((row) => row.positiveMinor > 0)
    .map((row, index) => {
      const start = angle;
      angle += (row.positiveMinor / Math.max(1, total)) * Math.PI * 2;
      const drawableEnd =
        angle - start >= Math.PI * 2 - 0.0001 ? angle - 0.0001 : angle;
      const share = Math.round((row.positiveMinor / Math.max(1, total)) * 100);
      const selected = state.selectedMasterCategoryId === row.key;
      return `<path class="donut-slice ${selected ? "selected" : ""}" d="${donutPath(start, drawableEnd)}" fill="${chartColors[index % chartColors.length]}" data-master-id="${escapeHtml(row.key)}" tabindex="0" role="button" aria-label="Filter to ${escapeHtml(row.name)}, ${share} percent, ${money.format(dollars(row.amount_minor))}"><title>${escapeHtml(row.name)}\n${money.format(dollars(row.amount_minor))} · ${share}%\n${Number(row.transaction_count ?? 0)} transactions</title></path>`;
    })
    .join("");
  const selectedRow = rows.find(
    (row) => row.key === state.selectedMasterCategoryId,
  );
  $("#master-category-donut").innerHTML = total
    ? `<svg viewBox="0 0 220 220" role="img" aria-label="Master category ${state.activityMode} donut">${paths}<circle class="donut-center" cx="110" cy="110" r="47"/><text class="donut-center-label" x="110" y="101">${selectedRow ? escapeHtml(selectedRow.name) : state.activityMode === "expense" ? "Expenses" : "Income"}</text><text class="donut-center-value" x="110" y="124">${money.format(dollars(selectedRow?.amount_minor ?? (state.activityMode === "expense" ? summary.expenseMinor : summary.incomeMinor)))}</text></svg>`
    : `<div class="empty">No positive ${state.activityMode} activity in this range.</div>`;
  $("#master-category-legend").innerHTML = rows.length
    ? rows
        .map((row, index) => {
          const selected = state.selectedMasterCategoryId === row.key;
          return `<button class="donut-legend-item ${selected ? "selected" : ""}" data-master-id="${escapeHtml(row.key)}" aria-pressed="${selected}"><i class="account-color-${index % chartColors.length}"></i><span>${escapeHtml(row.name)}</span><strong>${money.format(dollars(row.amount_minor))}</strong></button>`;
        })
        .join("")
    : "";
  renderCategoryRanking();
}
function selectMasterCategory(value) {
  state.selectedMasterCategoryId =
    state.selectedMasterCategoryId === value ? null : value;
  const master = state.summary?.activity?.[
    state.activityMode
  ]?.byMasterCategory.find((row) => masterKey(row.id) === value);
  state.activityTrendSelection = state.selectedMasterCategoryId
    ? { kind: "master", id: value, label: master?.name ?? "Master category" }
    : {
        kind: "all",
        id: null,
        label: `All ${state.activityMode === "expense" ? "expenses" : "income"}`,
      };
  renderSpendingBreakdown();
  renderFilteredActivityCards();
  void loadTrend();
}

function selectActivityTrend(kind, id, label) {
  const selected =
    state.activityTrendSelection.kind === kind &&
    state.activityTrendSelection.id === id;
  state.activityTrendSelection = selected
    ? {
        kind: "all",
        id: null,
        label: `All ${state.activityMode === "expense" ? "expenses" : "income"}`,
      }
    : { kind, id, label };
  renderCategoryRanking();
  renderFilteredActivityCards();
  void loadTrend();
}
function aggregateAccountRows(rows) {
  const totals = new Map();
  for (const row of rows) {
    const current = totals.get(row.id) ?? { ...row, amountMinor: 0 };
    current.amountMinor += Number(row.amount_minor ?? 0);
    totals.set(row.id, current);
  }
  return [...totals.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}
function renderFilteredActivityCards() {
  const summary = state.summary,
    data = summary?.activity?.[state.activityMode];
  if (!data) return;
  const selected = state.selectedMasterCategoryId,
    categories = data.byCategory.filter(
      (row) =>
        selected === null || masterKey(row.master_category_id) === selected,
    ),
    accountRows = data.byAccount.filter(
      (row) =>
        selected === null || masterKey(row.master_category_id) === selected,
    );
  drawBars("#account-bars", aggregateAccountRows(accountRows));
  $("#category-budget-status").innerHTML = categories.length
    ? categories
        .map((row) => {
          const target =
              Number(row.monthly_budget_minor ?? 0) * summary.monthCount,
            remaining = target - row.amount_minor;
          return `<div class="budget-row ${state.activityMode === "expense" && remaining < 0 ? "is-over" : ""}"><span>${escapeHtml(row.name)}</span><span>Actual ${money.format(dollars(row.amount_minor))}</span><span>${state.activityMode === "income" ? "Target" : "Budget"} ${money.format(dollars(target))}</span><strong>${target ? `${remaining < 0 ? (state.activityMode === "expense" ? "Over" : "Above target") : state.activityMode === "expense" ? "Left" : "To target"} ${money.format(dollars(Math.abs(remaining)))}` : `No ${state.activityMode === "income" ? "target" : "budget"} set`}</strong></div>`;
        })
        .join("")
    : `<div class="empty">No ${state.activityMode} activity in this range.</div>`;
}
function setActivityMode(mode) {
  state.activityMode = mode;
  state.selectedMasterCategoryId = null;
  $$(".activity-mode").forEach((button) => {
    const active = button.dataset.activityMode === mode;
    button.classList.toggle("secondary", !active);
    button.setAttribute("aria-pressed", String(active));
  });
  const cashFlow = mode === "cashflow";
  $("#activity-detail-view").hidden = cashFlow;
  $("#cashflow-view").hidden = !cashFlow;
  if (cashFlow) {
    void loadCashFlow();
    return;
  }
  const income = mode === "income";
  $("#activity-mix-eyebrow").textContent = income
    ? "Income mix"
    : "Spending mix";
  $("#activity-master-title").textContent = income
    ? "Income master categories"
    : "Expense master categories";
  $("#activity-account-title").textContent = income
    ? "Income by receiving account"
    : "Expenses by account";
  $("#activity-budget-title").textContent = income
    ? "Income target tracking"
    : "Category budget tracking";
  $("#activity-trend-title").textContent = income
    ? "Income trend"
    : "Expense trend";
  state.activityTrendSelection = {
    kind: "all",
    id: null,
    label: `All ${income ? "income" : "expenses"}`,
  };
  renderSpendingBreakdown();
  renderFilteredActivityCards();
  void loadTrend();
}
async function loadSummary() {
  const range = new URLSearchParams({
    startDate: $("#summary-start-date").value,
    endDate: $("#summary-end-date").value,
  });
  const result = await api(`/api/v1/monthly-summary?${range}`);
  const data = result.data;
  state.summary = data;
  if (
    state.activityMode !== "cashflow" &&
    state.selectedMasterCategoryId !== null &&
    !data.activity[state.activityMode].byMasterCategory.some(
      (row) => masterKey(row.id) === state.selectedMasterCategoryId,
    )
  ) {
    state.selectedMasterCategoryId = null;
    state.activityTrendSelection = {
      kind: "all",
      id: null,
      label: `All ${state.activityMode === "expense" ? "expenses" : "income"}`,
    };
  }
  $("#income-total").textContent = money.format(dollars(data.incomeMinor));
  $("#expense-total").textContent = money.format(dollars(data.expenseMinor));
  $("#cashflow-total").textContent = money.format(
    dollars(data.netCashFlowMinor),
  );
  $("#transaction-count").textContent = data.transactionCount;
  $("#budget-total").textContent = money.format(dollars(data.totalBudgetMinor));
  $("#budget-remaining").textContent = money.format(
    dollars(data.budgetRemainingMinor),
  );
  $("#budget-remaining").classList.toggle(
    "over-budget",
    data.budgetRemainingMinor < 0,
  );
  $("#month-comparison").textContent =
    `Showing ${data.startDate} through ${data.endDate} (${data.monthCount} budget month${data.monthCount === 1 ? "" : "s"}).`;
  renderSpendingBreakdown();
  renderFilteredActivityCards();
  if (state.activityMode === "cashflow") await loadCashFlow();
  else await loadTrend();
}
function drawTrend(selector, rows) {
  if (!rows.length) {
    $(selector).innerHTML = '<div class="empty">No months in this range.</div>';
    return;
  }
  const values = rows.flatMap((row) => [
      row.actualMinor,
      row.budgetMinor,
      row.averageMinor,
    ]),
    max = Math.max(1, ...values),
    plot = { left: 86, right: 1172, top: 36, bottom: 374 },
    x = (index) =>
      rows.length === 1
        ? (plot.left + plot.right) / 2
        : plot.left +
          (index / Math.max(1, rows.length - 1)) * (plot.right - plot.left),
    y = (value) => plot.bottom - (value / max) * (plot.bottom - plot.top),
    currencyLabel = (minor) =>
      new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: "CAD",
        notation: Math.abs(minor) >= 100_000 ? "compact" : "standard",
        maximumFractionDigits: Math.abs(minor) >= 100_000 ? 1 : 0,
      }).format(dollars(minor)),
    monthLabel = (month) =>
      new Intl.DateTimeFormat("en-CA", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${month}-01T00:00:00Z`));
  const path = (key) =>
    rows
      .map((row, index) => `${index ? "L" : "M"}${x(index)},${y(row[key])}`)
      .join(" ");
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = (max * index) / 4;
    return `<line class="chart-grid" x1="${plot.left}" y1="${y(value)}" x2="${plot.right}" y2="${y(value)}"/><text class="axis-label y-axis-label" x="${plot.left - 10}" y="${y(value) + 4}">${currencyLabel(value)}</text>`;
  }).join("");
  const months = rows
    .map((row, index) => {
      const pointX = x(index);
      return `<line class="month-guide" x1="${pointX}" y1="${plot.top}" x2="${pointX}" y2="${plot.bottom}"/><text class="axis-label month-label" transform="translate(${pointX},${plot.bottom + 18}) rotate(-38)">${escapeHtml(monthLabel(row.month))}</text>`;
    })
    .join("");
  const points = rows
    .map((row, index) => {
      const pointX = x(index),
        actualY = y(row.actualMinor),
        budgetY = y(row.budgetMinor),
        averageY = y(row.averageMinor),
        title = `${row.month}: actual ${money.format(dollars(row.actualMinor))}, budget ${money.format(dollars(row.budgetMinor))}, average ${money.format(dollars(row.averageMinor))}`;
      return `<g class="trend-point actual-point"><circle cx="${pointX}" cy="${actualY}" r="4"><title>${escapeHtml(title)}</title></circle><text class="trend-value actual-value" x="${pointX - 6}" y="${Math.max(plot.top + 11, actualY - 10)}">${currencyLabel(row.actualMinor)}</text></g><g class="trend-point budget-point"><circle cx="${pointX}" cy="${budgetY}" r="4"><title>${escapeHtml(title)}</title></circle><text class="trend-value budget-value" x="${pointX + 6}" y="${Math.max(plot.top + 24, budgetY - 10)}">${currencyLabel(row.budgetMinor)}</text></g><g class="trend-point average-point"><circle cx="${pointX}" cy="${averageY}" r="4"><title>${escapeHtml(title)}</title></circle><text class="trend-value average-value" x="${pointX}" y="${Math.min(plot.bottom - 5, averageY + 18)}">${currencyLabel(row.averageMinor)}</text></g>`;
    })
    .join("");
  $(selector).innerHTML =
    `<div class="trend-chart-frame"><svg viewBox="0 0 1200 455" role="img" aria-label="Actual, budget, and average monthly trend with monthly and dollar labels">${grid}${months}<path class="trend-actual" d="${path("actualMinor")}"/><path class="trend-budget" d="${path("budgetMinor")}"/><path class="trend-average" d="${path("averageMinor")}"/>${points}</svg></div><div class="trend-legend"><span class="actual-key">Actual</span><span class="budget-key">Budget</span><span class="average-key">Average actual</span></div>`;
}
async function loadTrend() {
  const selection = state.activityTrendSelection,
    type = state.activityMode;
  const params = new URLSearchParams({
    startDate: $("#summary-start-date").value,
    endDate: $("#summary-end-date").value,
    type,
  });
  if (state.selectedMasterCategoryId)
    params.set("masterCategoryId", state.selectedMasterCategoryId);
  if (selection.kind === "category") params.set("categoryId", selection.id);
  if (selection.kind === "account") params.set("accountId", selection.id);
  $("#activity-trend-filter-label").textContent = `Showing ${selection.label}`;
  $("#clear-activity-trend-filter").hidden =
    selection.kind === "all" || selection.kind === "master";
  const result = await api(`/api/v1/spending-trends?${params}`);
  drawTrend("#expense-trend-chart", result.data);
}

const selectedCashFlowSeries = (kind) => {
  const rows = state.cashFlowData?.[`${kind}Series`] ?? [];
  const selected = state.cashFlowSelections[kind];
  return rows.filter((row) => selected.has(row.id));
};
function renderCashFlowFilters() {
  if (!state.cashFlowData) return;
  for (const kind of ["expense", "income"]) {
    const rows = state.cashFlowData[`${kind}Series`];
    const selected = state.cashFlowSelections[kind];
    $(`[data-cashflow-options="${kind}"]`).innerHTML = rows
      .map(
        (row) =>
          `<label><input type="checkbox" data-cashflow-kind="${kind}" value="${escapeHtml(row.id)}" ${selected.has(row.id) ? "checked" : ""}/> <span>${escapeHtml(row.name)}</span></label>`,
      )
      .join("");
    $(`[data-filter-count="${kind}"]`).textContent =
      selected.size === rows.length
        ? "All"
        : `${selected.size} of ${rows.length}`;
  }
}
function drawCashFlowChart() {
  const data = state.cashFlowData;
  if (!data?.months.length) {
    $("#cashflow-chart").innerHTML =
      '<div class="empty">No months in this range.</div>';
    return;
  }
  const expenseRows = selectedCashFlowSeries("expense"),
    incomeRows = selectedCashFlowSeries("income"),
    count = data.months.length,
    // Keep refunds/reversals in the arithmetic so the bold cash-flow line is
    // always the true net result. Negative category layers collapse at zero
    // because they cannot be meaningfully stacked on the expense side.
    sumAt = (rows, index) =>
      rows.reduce((sum, row) => sum + Number(row.values[index] ?? 0), 0),
    incomeTotals = data.months.map((_, index) => sumAt(incomeRows, index)),
    expenseTotals = data.months.map((_, index) => sumAt(expenseRows, index)),
    cashTotals = incomeTotals.map(
      (value, index) => value - expenseTotals[index],
    ),
    incomeBudget = incomeRows.reduce(
      (sum, row) => sum + Number(row.budgetMinor ?? 0),
      0,
    ),
    expenseBudget = expenseRows.reduce(
      (sum, row) => sum + Number(row.budgetMinor ?? 0),
      0,
    ),
    cashBudget = incomeBudget - expenseBudget,
    bound = Math.max(
      1,
      ...incomeTotals,
      ...expenseTotals,
      ...cashTotals.map(Math.abs),
      incomeBudget,
      expenseBudget,
      Math.abs(cashBudget),
    ),
    plot = { left: 86, right: 1172, top: 34, bottom: 404 },
    x = (index) =>
      count === 1
        ? (plot.left + plot.right) / 2
        : plot.left + (index / (count - 1)) * (plot.right - plot.left),
    y = (value) =>
      plot.top + ((bound - value) / (bound * 2)) * (plot.bottom - plot.top),
    line = (values) =>
      values
        .map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`)
        .join(" "),
    area = (lower, upper) =>
      `${upper.map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join(" ")} ${lower
        .map((value, reverseIndex) => {
          const index = count - reverseIndex - 1;
          return `L${x(index)},${y(lower[index])}`;
        })
        .join(" ")} Z`,
    monthLabel = (month) =>
      new Intl.DateTimeFormat("en-CA", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${month}-01T00:00:00Z`)),
    compactMoney = (minor) =>
      new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: "CAD",
        notation: Math.abs(minor) >= 100000 ? "compact" : "standard",
        maximumFractionDigits: Math.abs(minor) >= 100000 ? 1 : 0,
      }).format(dollars(minor));
  const grid = [-1, -0.5, 0, 0.5, 1]
    .map(
      (ratio) =>
        `<line class="chart-grid ${ratio === 0 ? "cashflow-zero" : ""}" x1="${plot.left}" y1="${y(bound * ratio)}" x2="${plot.right}" y2="${y(bound * ratio)}"/><text class="axis-label y-axis-label" x="${plot.left - 10}" y="${y(bound * ratio) + 4}">${compactMoney(bound * ratio)}</text>`,
    )
    .join("");
  const buildLayers = (rows, direction, colorOffset) => {
    let lower = Array(count).fill(0);
    return rows
      .map((row, index) => {
        const delta = row.values.map(
          (value) => Math.max(0, Number(value ?? 0)) * direction,
        );
        const upper = lower.map((value, point) => value + delta[point]);
        const color =
          state.cashFlowColorBy === "type"
            ? direction > 0
              ? "var(--positive)"
              : "var(--danger)"
            : chartColors[(index + colorOffset) % chartColors.length];
        const markup = `<path class="cashflow-area" style="fill:${color}" d="${area(lower, upper)}"><title>${escapeHtml(row.name)}</title></path>`;
        lower = upper;
        return markup;
      })
      .join("");
  };
  const displayIncome =
    state.cashFlowColorBy === "type"
      ? [{ name: "Income", values: incomeTotals }]
      : incomeRows;
  const displayExpense =
    state.cashFlowColorBy === "type"
      ? [{ name: "Expenses", values: expenseTotals }]
      : expenseRows;
  const areas =
    buildLayers(displayIncome, 1, 0) +
    buildLayers(displayExpense, -1, Math.max(1, displayIncome.length));
  const guides = data.months
    .map(
      (month, index) =>
        `<line class="month-guide" x1="${x(index)}" y1="${plot.top}" x2="${x(index)}" y2="${plot.bottom}"/><text class="axis-label month-label" transform="translate(${x(index)},${plot.bottom + 18}) rotate(-38)">${escapeHtml(monthLabel(month))}</text>`,
    )
    .join("");
  const budgetLines =
    state.cashFlowColorBy === "type"
      ? `<path class="cashflow-budget income-budget-line" d="${line(Array(count).fill(incomeBudget))}"/><path class="cashflow-budget expense-budget-line" d="${line(Array(count).fill(-expenseBudget))}"/><path class="cashflow-budget net-budget-line" d="${line(Array(count).fill(cashBudget))}"/>`
      : "";
  const points = cashTotals
    .map(
      (value, index) =>
        `<g class="cashflow-point"><circle cx="${x(index)}" cy="${y(value)}" r="4"><title>${escapeHtml(monthLabel(data.months[index]))}: income ${money.format(dollars(incomeTotals[index]))}, expenses ${money.format(dollars(expenseTotals[index]))}, cash flow ${money.format(dollars(value))}</title></circle><text x="${x(index)}" y="${Math.max(plot.top + 12, y(value) - 10)}">${compactMoney(value)}</text></g>`,
    )
    .join("");
  const legend =
    state.cashFlowColorBy === "type"
      ? `<span class="income-key">Actual income</span><span class="expense-key">Actual expenses</span><span class="cash-key">Actual cash flow</span><span class="income-budget-key">Income budget</span><span class="expense-budget-key">Expense budget</span><span class="net-budget-key">Budgeted cash flow</span>`
      : [...incomeRows, ...expenseRows]
          .map(
            (row, index) =>
              `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(row.name)}</span>`,
          )
          .join("") + `<span class="cash-key">Cash flow</span>`;
  $("#cashflow-chart").innerHTML =
    `<div class="trend-chart-frame"><svg viewBox="0 0 1200 480" role="img" aria-label="Income above zero, expenses below zero, and net cash flow by month">${grid}${guides}${areas}${budgetLines}<path class="cashflow-net-line" d="${line(cashTotals)}"/>${points}</svg></div><div class="cashflow-legend">${legend}</div>`;
  $("#cashflow-budget-note").hidden = state.cashFlowColorBy !== "type";
}
async function loadCashFlow() {
  const params = new URLSearchParams({
    startDate: $("#summary-start-date").value,
    endDate: $("#summary-end-date").value,
  });
  const result = await api(`/api/v1/cash-flow-trends?${params}`);
  state.cashFlowData = result.data;
  if (!state.cashFlowFiltersInitialized) {
    state.cashFlowSelections.expense = new Set(
      result.data.expenseSeries.map((row) => row.id),
    );
    state.cashFlowSelections.income = new Set(
      result.data.incomeSeries.map((row) => row.id),
    );
    state.cashFlowFiltersInitialized = true;
  } else {
    for (const kind of ["expense", "income"]) {
      const valid = new Set(result.data[`${kind}Series`].map((row) => row.id));
      state.cashFlowSelections[kind] = new Set(
        [...state.cashFlowSelections[kind]].filter((id) => valid.has(id)),
      );
    }
  }
  renderCashFlowFilters();
  drawCashFlowChart();
}

async function loadBudget() {
  const result = await api("/api/v1/budgets");
  state.categories = result.data;
  for (const type of ["expense", "income"]) {
    const rows = state.categories.filter(
      (item) => item.active !== 0 && item.kind === type,
    );
    $(`#${type}-budget-list`).innerHTML = rows
      .map(
        (item) =>
          `<label class="budget-input"><span>${escapeHtml(item.name)}</span><input name="budget-${escapeHtml(item.id)}" data-budget-id="${escapeHtml(item.id)}" data-budget-kind="${type}" type="number" min="0" step="0.01" value="${dollars(item.monthlyBudgetMinor)}" /></label>`,
      )
      .join("");
  }
  updateBudgetTotals();
}
function updateBudgetTotals() {
  const total = (kind) =>
    $$(`[data-budget-kind="${kind}"]`).reduce(
      (sum, input) => sum + cents(input.value || 0),
      0,
    );
  const expense = total("expense"),
    income = total("income");
  $("#expense-budget-total").textContent = money.format(dollars(expense));
  $("#income-budget-total").textContent = money.format(dollars(income));
  $("#planned-remainder").textContent = money.format(dollars(income - expense));
}
async function loadNetWorth() {
  const range = new URLSearchParams({
    startDate: $("#networth-start-date").value,
    endDate: $("#networth-end-date").value,
  });
  const [balances, projection, timeline, projectionRules] = await Promise.all([
    api("/api/v1/balance-snapshots"),
    api("/api/v1/projection"),
    api(`/api/v1/net-worth-timeline?${range}`),
    api("/api/v1/projection-rules"),
  ]);
  const latest = new Map();
  state.projectionRules = projectionRules.data;
  state.balanceSnapshots = balances.data;
  balances.data.forEach((row) => latest.set(row.accountId, row));
  const assets = projection.data.startAssetsMinor,
    liabilities = projection.data.startLiabilitiesMinor;
  $("#assets-total").textContent = money.format(dollars(assets));
  $("#liabilities-total").textContent = money.format(dollars(liabilities));
  $("#networth-total").textContent = money.format(
    dollars(assets - liabilities),
  );
  const points = timeline.data.points;
  state.netWorthTimeline = timeline.data;
  if (!points.length) {
    $("#projection-chart").innerHTML =
      '<div class="empty">No timeline points in this range.</div>';
    return;
  }
  const todayPoint =
    points.find((point) => point.date === timeline.data.today) ??
    points.filter((point) => point.date <= timeline.data.today).at(-1);
  if (todayPoint)
    $("#networth-total").textContent = money.format(
      dollars(todayPoint.netWorthMinor),
    );
  const fixed = points.map((point) => point.fixedNetWorthMinor),
    total = points.map((point) => point.netWorthMinor);
  const rawMin = Math.min(0, ...fixed, ...total),
    rawMax = Math.max(1, ...fixed, ...total),
    padding = Math.max(100, (rawMax - rawMin) * 0.12),
    min = rawMin - padding,
    max = rawMax + padding;
  const plot = { left: 84, right: 1180, top: 28, bottom: 390 };
  const startTime = Date.parse(`${points[0].date}T00:00:00Z`),
    endTime = Date.parse(`${points.at(-1).date}T00:00:00Z`);
  const xDate = (date) =>
    ((Date.parse(`${date}T00:00:00Z`) - startTime) /
      Math.max(1, endTime - startTime)) *
      (plot.right - plot.left) +
    plot.left;
  const y = (value) =>
    plot.bottom - ((value - min) / (max - min)) * (plot.bottom - plot.top);
  const line = (rows, key) =>
    rows
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${xDate(point.date).toFixed(1)},${y(point[key]).toFixed(1)}`,
      )
      .join(" ");
  const area = `${line(points, "netWorthMinor")} ${points
    .slice()
    .reverse()
    .map(
      (point) =>
        `L${xDate(point.date).toFixed(1)},${y(point.fixedNetWorthMinor).toFixed(1)}`,
    )
    .join(" ")} Z`;
  const actual = points.filter((point) => point.date <= timeline.data.today),
    projected = points.filter((point) => point.date >= timeline.data.today);
  const todayX =
    timeline.data.today >= points[0].date &&
    timeline.data.today <= points.at(-1).date
      ? xDate(timeline.data.today)
      : null;
  const tickValues = Array.from(
    { length: 6 },
    (_, index) => min + ((max - min) * index) / 5,
  );
  const currencyLabel = (minor) =>
    new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      maximumFractionDigits: 0,
      notation: Math.abs(minor) >= 100_000_000 ? "compact" : "standard",
    }).format(dollars(minor));
  const monthLabel = (date) =>
    new Intl.DateTimeFormat("en-CA", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
  const monthly = points.filter(
    (point, index) =>
      index === 0 ||
      index === points.length - 1 ||
      point.date.endsWith("-01") ||
      point.date === timeline.data.today,
  );
  const labelStep = Math.max(1, Math.ceil(monthly.length / 24));
  const grid = tickValues
    .map(
      (value) =>
        `<line class="chart-grid" x1="${plot.left}" y1="${y(value)}" x2="${plot.right}" y2="${y(value)}"/><text class="axis-label y-axis-label" x="${plot.left - 10}" y="${y(value) + 4}">${currencyLabel(value)}</text>`,
    )
    .join("");
  const monthMarks = monthly
    .map((point, index) => {
      const x = xDate(point.date);
      const showLabel = index % labelStep === 0 || index === monthly.length - 1;
      return `<line class="month-guide" x1="${x}" y1="${plot.top}" x2="${x}" y2="${plot.bottom}"/>${showLabel ? `<text class="axis-label month-label" transform="translate(${x},${plot.bottom + 17}) rotate(-38)">${monthLabel(point.date)}</text>` : ""}<g class="chart-point"><circle cx="${x}" cy="${y(point.netWorthMinor)}" r="4"/><title>${point.date} (${point.phase})\nFixed: ${money.format(dollars(point.fixedNetWorthMinor))}\nLiquid: ${money.format(dollars(point.liquidNetWorthMinor))}\nTotal: ${money.format(dollars(point.netWorthMinor))}</title></g>${showLabel ? `<text class="value-label total-value" x="${x}" y="${Math.max(plot.top + 12, y(point.netWorthMinor) - 10)}">${currencyLabel(point.netWorthMinor)}</text><text class="value-label fixed-value" x="${x}" y="${Math.min(plot.bottom - 7, y(point.fixedNetWorthMinor) + 17)}">${currencyLabel(point.fixedNetWorthMinor)}</text>` : ""}`;
    })
    .join("");
  $("#projection-chart").innerHTML =
    `<div class="chart-scroll"><svg viewBox="0 0 1200 470" role="img" aria-label="Monthly historical and projected fixed and liquid net worth">${grid}${monthMarks}<line class="zero-line" x1="${plot.left}" y1="${y(0)}" x2="${plot.right}" y2="${y(0)}"/><path class="fixed-area" d="${line(points, "fixedNetWorthMinor")} L${plot.right},${y(0)} L${plot.left},${y(0)} Z"/><path class="liquid-area" d="${area}"/><path class="fixed-line actual-line" d="${line(actual, "fixedNetWorthMinor")}"/><path class="total-line actual-line" d="${line(actual, "netWorthMinor")}"/><path class="fixed-line projected-line" d="${line(projected, "fixedNetWorthMinor")}"/><path class="total-line projected-line" d="${line(projected, "netWorthMinor")}"/>${todayX === null ? "" : `<line class="today-line" x1="${todayX}" y1="${plot.top}" x2="${todayX}" y2="${plot.bottom}"/><text class="today-label" x="${Math.min(plot.right - 45, todayX + 8)}" y="${plot.top + 15}">Today</text>`}</svg></div><div class="chart-values"><span>Start: fixed ${money.format(dollars(fixed[0]))}, liquid ${money.format(dollars(points[0].liquidNetWorthMinor))}</span><span>End: fixed ${money.format(dollars(fixed.at(-1)))}, liquid ${money.format(dollars(points.at(-1).liquidNetWorthMinor))}</span></div>`;
  initializeNetWorthAccountSelection();
  renderNetWorthAccountControls();
  renderAccountNetWorthChart();
  renderNetWorthRelatedLists();
}

function renderNetWorthRelatedLists() {
  const selected = state.selectedNetWorthAccounts;
  const rules = state.projectionRules.filter(
    (item) =>
      selected.has(item.fromAccountId) || selected.has(item.toAccountId),
  );
  $("#projection-rules-list").innerHTML = rules.length
    ? rules
        .map((item) => {
          const route =
            item.ruleType === "income"
              ? `Into ${item.toAccountName}`
              : item.ruleType === "expense"
                ? `From ${item.fromAccountName}`
                : `${item.fromAccountName} → ${item.toAccountName}`;
          const schedule =
            item.frequency === "once"
              ? `once on ${item.startDate}`
              : `${item.frequency} from ${item.startDate}`;
          return `<article class="projection-rule"><div><strong>${escapeHtml(item.description)}</strong><span>${escapeHtml(item.ruleType)} · ${escapeHtml(schedule)} · ${escapeHtml(route)}</span></div><div><strong>${money.format(dollars(item.amountMinor))}</strong><button class="secondary edit-projection-rule" data-id="${escapeHtml(item.id)}">Edit</button><button class="secondary danger delete-projection-rule" data-id="${escapeHtml(item.id)}">Delete</button></div></article>`;
        })
        .join("")
    : '<div class="empty">No projection rules affect the selected accounts.</div>';
  const balances = state.balanceSnapshots.filter((row) =>
    selected.has(row.accountId),
  );
  $("#balances-body").innerHTML = balances.length
    ? balances
        .map(
          (row) =>
            `<tr><td>${escapeHtml(row.snapshotDate)}</td><td>${escapeHtml(row.accountName)}</td><td>${escapeHtml(row.accountType)}</td><td class="money">${money.format(dollars(row.balanceMinor))}</td><td><button class="secondary edit-balance" data-id="${escapeHtml(row.id)}">Edit</button> <button class="secondary danger delete-balance" data-id="${escapeHtml(row.id)}">Delete</button></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty">No recorded balances for the selected accounts.</td></tr>';
}

function timelineAccounts() {
  const seen = new Map();
  for (const point of state.netWorthTimeline?.points ?? [])
    for (const account of point.accounts ?? [])
      if (!seen.has(account.id)) seen.set(account.id, account);
  return [...seen.values()];
}
function accountIsLiability(account) {
  return ["liability", "credit_card"].includes(account.accountType);
}
function accountColor(accountId) {
  const ids = timelineAccounts()
    .map((account) => account.id)
    .sort();
  return chartColors[Math.max(0, ids.indexOf(accountId)) % chartColors.length];
}
function initializeNetWorthAccountSelection() {
  const ids = new Set(timelineAccounts().map((account) => account.id));
  state.selectedNetWorthAccounts = new Set(
    [...state.selectedNetWorthAccounts].filter((id) => ids.has(id)),
  );
  if (!state.netWorthSelectionInitialized) {
    state.selectedNetWorthAccounts = ids;
    state.netWorthSelectionInitialized = true;
  }
}
function renderNetWorthAccountControls() {
  const accounts = timelineAccounts();
  $("#networth-account-toggles").innerHTML = accounts
    .map((account) => {
      const checked = state.selectedNetWorthAccounts.has(account.id);
      const colorIndex = chartColors.indexOf(accountColor(account.id));
      return `<label class="account-toggle account-color-${colorIndex} ${accountIsLiability(account) ? "liability-account" : "asset-account"}"><input type="checkbox" data-networth-account="${escapeHtml(account.id)}" ${checked ? "checked" : ""}/><i></i><span>${escapeHtml(account.name)} <small>${accountIsLiability(account) ? "liability" : "asset"} · ${escapeHtml(account.liquidityClass)}</small></span></label>`;
    })
    .join("");
}
function accountBalance(point, accountId) {
  return (
    point.accounts?.find((account) => account.id === accountId)?.balanceMinor ??
    0
  );
}
function showNetWorthAccountDetail(accountId, pointIndex) {
  const timeline = state.netWorthTimeline,
    points = timeline?.points ?? [],
    account = timelineAccounts().find((item) => item.id === accountId),
    point = points[pointIndex];
  if (!account || !point) return;
  const value = accountBalance(point, accountId),
    previous = pointIndex
      ? accountBalance(points[pointIndex - 1], accountId)
      : value,
    first = accountBalance(points[0], accountId),
    monthlyChange = value - previous,
    rangeChange = value - first;
  const change = (amount) =>
    `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${money.format(Math.abs(dollars(amount)))}`;
  const detail = $("#networth-account-detail");
  detail.innerHTML = `<div><span>${escapeHtml(account.name)}</span><strong>${money.format(dollars(value))}</strong></div><dl><div><dt>Date</dt><dd>${escapeHtml(point.date)} · ${escapeHtml(point.phase)}</dd></div><div><dt>Account</dt><dd>${escapeHtml(account.accountType.replaceAll("_", " "))} · ${escapeHtml(account.liquidityClass)}</dd></div><div><dt>Change from prior point</dt><dd class="${monthlyChange < 0 ? "negative" : "positive"}">${change(monthlyChange)}</dd></div><div><dt>Change across selected range</dt><dd class="${rangeChange < 0 ? "negative" : "positive"}">${change(rangeChange)}</dd></div></dl>`;
  detail.hidden = false;
}
function renderAccountNetWorthChart() {
  const timeline = state.netWorthTimeline,
    points = timeline?.points ?? [],
    accounts = timelineAccounts()
      .filter((account) => state.selectedNetWorthAccounts.has(account.id))
      .sort(
        (left, right) =>
          Number(accountIsLiability(left)) -
            Number(accountIsLiability(right)) ||
          left.name.localeCompare(right.name),
      );
  if (!points.length || !accounts.length) {
    $("#projection-chart").innerHTML =
      '<div class="empty">Select one or more accounts to draw the account breakdown.</div>';
    $("#networth-account-detail").hidden = true;
    return;
  }
  if (
    state.selectedNetWorthSeries !== "networth" &&
    !accounts.some((account) => account.id === state.selectedNetWorthSeries)
  )
    state.selectedNetWorthSeries = "networth";
  const layers = accounts.map((account) => ({ account, lower: [], upper: [] })),
    totals = [];
  points.forEach((point, pointIndex) => {
    let positive = 0,
      negative = 0;
    layers.forEach((layer) => {
      const value = accountBalance(point, layer.account.id);
      if (value >= 0) {
        layer.lower[pointIndex] = positive;
        positive += value;
        layer.upper[pointIndex] = positive;
      } else {
        layer.lower[pointIndex] = negative;
        negative += value;
        layer.upper[pointIndex] = negative;
      }
    });
    totals.push(positive + negative);
  });
  const bounds = layers.flatMap((layer) => [...layer.lower, ...layer.upper]),
    rawMin = Math.min(0, ...bounds, ...totals),
    rawMax = Math.max(1, ...bounds, ...totals),
    padding = Math.max(100, (rawMax - rawMin) * 0.12),
    min = rawMin - padding,
    max = rawMax + padding,
    plot = { left: 84, right: 1180, top: 28, bottom: 390 },
    x = (index) =>
      plot.left +
      (index / Math.max(1, points.length - 1)) * (plot.right - plot.left),
    y = (value) =>
      plot.bottom - ((value - min) / (max - min)) * (plot.bottom - plot.top),
    currencyLabel = (minor) =>
      new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: "CAD",
        maximumFractionDigits: 0,
        notation: Math.abs(minor) >= 100_000_000 ? "compact" : "standard",
      }).format(dollars(minor)),
    monthLabel = (date) =>
      new Intl.DateTimeFormat("en-CA", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`));
  const path = (values) =>
    values
      .map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`)
      .join(" ");
  const patternDefinitions = accounts
    .filter(accountIsLiability)
    .map(
      (account) =>
        `<pattern id="liability-${escapeHtml(account.id)}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="8" height="8" fill="${accountColor(account.id)}" fill-opacity=".3"/><line x1="0" y1="0" x2="0" y2="8" stroke="${accountColor(account.id)}" stroke-width="3"/></pattern>`,
    )
    .join("");
  const areas = layers
    .map((layer) => {
      const area = `${path(layer.upper)} ${layer.lower
        .slice()
        .reverse()
        .map((value, reverseIndex) => {
          const pointIndex = layer.lower.length - reverseIndex - 1;
          return `L${x(pointIndex)},${y(value)}`;
        })
        .join(" ")} Z`;
      const hoverPoints = points
        .map((point, pointIndex) => {
          const value = accountBalance(point, layer.account.id);
          return `<circle class="account-hover-target" data-networth-series="${escapeHtml(layer.account.id)}" data-account-id="${escapeHtml(layer.account.id)}" data-point-index="${pointIndex}" cx="${x(pointIndex)}" cy="${y(layer.upper[pointIndex])}" r="9" tabindex="0"><title>${escapeHtml(layer.account.name)}\n${point.date}: ${money.format(dollars(value))}</title></circle>`;
        })
        .join("");
      const fill = accountIsLiability(layer.account)
        ? `url(#liability-${escapeHtml(layer.account.id)})`
        : accountColor(layer.account.id);
      const selected = state.selectedNetWorthSeries === layer.account.id;
      return `<g class="account-layer ${accountIsLiability(layer.account) ? "liability-layer" : "asset-layer"} ${selected ? "series-selected" : state.selectedNetWorthSeries === "networth" ? "" : "series-muted"}"><path class="account-series-path" data-networth-series="${escapeHtml(layer.account.id)}" d="${area}" fill="${fill}" tabindex="0"><title>${escapeHtml(layer.account.name)} · ${accountIsLiability(layer.account) ? "liability below zero" : "asset above zero"}</title></path>${hoverPoints}</g>`;
    })
    .join("");
  const tickValues = Array.from(
      { length: 6 },
      (_, index) => min + ((max - min) * index) / 5,
    ),
    grid = tickValues
      .map(
        (value) =>
          `<line class="chart-grid" x1="${plot.left}" y1="${y(value)}" x2="${plot.right}" y2="${y(value)}"/><text class="axis-label y-axis-label" x="${plot.left - 10}" y="${y(value) + 4}">${currencyLabel(value)}</text>`,
      )
      .join(""),
    labelStep = Math.max(1, Math.ceil(points.length / 18)),
    months = points
      .map((point, index) =>
        index % labelStep === 0 || index === points.length - 1
          ? `<text class="axis-label month-label" transform="translate(${x(index)},${plot.bottom + 17}) rotate(-38)">${monthLabel(point.date)}</text>`
          : "",
      )
      .join(""),
    totalLine = path(totals),
    selectedLayer = layers.find(
      (layer) => layer.account.id === state.selectedNetWorthSeries,
    ),
    selectedValues = selectedLayer
      ? points.map((point) => accountBalance(point, selectedLayer.account.id))
      : totals,
    selectedCoordinates = selectedLayer?.upper ?? totals,
    selectedColor = selectedLayer
      ? accountColor(selectedLayer.account.id)
      : "#10251d",
    valueLabels = points
      .map((point, index) =>
        index % labelStep === 0 || index === points.length - 1
          ? `<text class="account-series-value" x="${x(index)}" y="${Math.max(plot.top + 12, y(selectedCoordinates[index]) - 9)}" fill="${selectedColor}">${currencyLabel(selectedValues[index])}</text>`
          : "",
      )
      .join(""),
    todayIndex = points.findIndex((point) => point.date === timeline.today),
    todayLine =
      todayIndex < 0
        ? ""
        : `<line class="today-line" x1="${x(todayIndex)}" y1="${plot.top}" x2="${x(todayIndex)}" y2="${plot.bottom}"/><text class="today-label" x="${Math.min(plot.right - 45, x(todayIndex) + 8)}" y="${plot.top + 15}">Today</text>`;
  $("#projection-chart").innerHTML =
    `<div class="chart-scroll"><svg viewBox="0 0 1200 470" role="img" aria-label="Diverging account composition with assets above zero and liabilities below zero"><defs>${patternDefinitions}</defs>${grid}${areas}<line class="zero-line" x1="${plot.left}" y1="${y(0)}" x2="${plot.right}" y2="${y(0)}"/><text class="account-side-label" x="${plot.left + 8}" y="${Math.max(plot.top + 16, y(0) - 10)}">Assets</text><text class="account-side-label" x="${plot.left + 8}" y="${Math.min(plot.bottom - 8, y(0) + 20)}">Liabilities</text><path class="account-total-line ${state.selectedNetWorthSeries === "networth" ? "series-selected" : "series-muted"}" data-networth-series="networth" tabindex="0" d="${totalLine}"/><path class="account-total-hit" data-networth-series="networth" d="${totalLine}"/>${valueLabels}${todayLine}${months}</svg></div><div class="chart-values"><span>${accounts.length} account${accounts.length === 1 ? "" : "s"} selected · each colour is one account</span><span>Selected net worth: ${money.format(dollars(totals.at(-1)))}</span></div>`;
  showNetWorthAccountDetail(accounts[0].id, points.length - 1);
}
async function showView() {
  const id = window.location.hash.slice(1) || "transactions";
  $$(".view").forEach((view) => {
    view.hidden = view.id !== id;
  });
  $$(".topbar nav a").forEach((link) =>
    link.classList.toggle("active", link.hash === `#${id}`),
  );
  if (mobileNavigation()) setMobileNavigation(false);
  await run(async () => {
    if (id === "transactions") await loadTransactions();
    if (id === "spending") await loadSummary();
    if (id === "budget") await loadBudget();
    if (id === "net-worth") await loadNetWorth();
    if (id === "settings") await loadLookups();
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i],
      next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function mappingSelect(name, headers, guesses) {
  const guessed =
    headers.find((header) =>
      guesses.some((guess) => header.toLowerCase().includes(guess)),
    ) ?? "";
  return `<label>${name}<select name="map-${name.toLowerCase().replace(/\W/g, "-")}"><option value="">Not mapped</option>${headers.map((header) => `<option ${header === guessed ? "selected" : ""}>${escapeHtml(header)}</option>`).join("")}</select></label>`;
}
function normalizeCsvRows(rows) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(rows[0]?.[0] ?? "") && rows[0]?.length >= 4)
    return [["Transaction Date", "Description", "Debit", "Credit"], ...rows];
  return rows;
}
function importMapping(headers) {
  const keys = ["date", "vendor", "amount", "debit", "credit"];
  return {
    ...Object.fromEntries(
      keys.map((key) => [
        key,
        headers.indexOf($(`[name="map-${key}"]`)?.value),
      ]),
    ),
    postedDate: headers.indexOf($('[name="map-posted-date"]')?.value),
    transactionId: headers.indexOf($('[name="map-transaction-id"]')?.value),
  };
}
function importRowAmount(row, index) {
  return importRowMoney(row, index).amount;
}
function importRowMoney(row, index) {
  if (index.amount >= 0 && String(row[index.amount] ?? "").trim() !== "") {
    const amount = parseMoney(row[index.amount]);
    return {
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      error: Number.isFinite(amount) ? "" : "The amount is not a number.",
    };
  }
  const debitText =
    index.debit >= 0 ? String(row[index.debit] ?? "").trim() : "";
  const creditText =
    index.credit >= 0 ? String(row[index.credit] ?? "").trim() : "";
  if (debitText && creditText)
    return {
      amount: NaN,
      direction: null,
      error: "Both outgoing and incoming columns contain a value.",
    };
  if (!debitText && !creditText)
    return {
      amount: NaN,
      direction: null,
      error: "Neither outgoing nor incoming column contains a value.",
    };
  const outgoing = Boolean(debitText),
    parsed = parseMoney(outgoing ? debitText : creditText);
  return {
    amount: Number.isFinite(parsed)
      ? outgoing
        ? -Math.abs(parsed)
        : Math.abs(parsed)
      : NaN,
    direction: outgoing ? "debit" : "credit",
    error: Number.isFinite(parsed)
      ? ""
      : `The ${outgoing ? "outgoing" : "incoming"} amount is not a number.`,
  };
}
function inferImportType(amount, vendor) {
  if (
    /payment received|thank you|internet transfer|e-transfer|bill pay.*mastercard|from account|to account/i.test(
      vendor,
    )
  )
    return "transfer";
  return amount < 0 ? "expense" : "income";
}
function transactionDirectionForType(type) {
  return type === "income" || type === "refund" ? "credit" : "debit";
}
function updateProjectionRuleFields() {
  const form = $("#projection-rule-form"),
    type = form.elements.ruleType.value,
    fromField = $("#projection-from-field"),
    toField = $("#projection-to-field");
  fromField.hidden = type === "income";
  toField.hidden = type === "expense";
  form.elements.fromAccountId.required = type !== "income";
  form.elements.toAccountId.required = type !== "expense";
  if (type === "income") form.elements.fromAccountId.value = "";
  if (type === "expense") form.elements.toAccountId.value = "";
  $("#projection-rule-help").textContent =
    type === "income"
      ? "Income increases the selected destination account."
      : type === "expense"
        ? "The expense reduces the selected source account; choosing a credit card increases the debt owed."
        : "A transfer reduces the source and increases the destination. Use this for savings, debt payments, or moving money between accounts.";
}
function renderImportPreview() {
  const [headers, ...rows] = state.csv.rows;
  const index = importMapping(headers);
  const selectedDateOrder = $('[name="date-format"]')?.value ?? "auto";
  const inferredDateOrder = inferDateOrder(
    rows.map((row) => (index.date >= 0 ? row[index.date] : "")),
  );
  const outgoingAmounts = new Set(
    rows
      .map((row) => importRowAmount(row, index))
      .filter((amount) => Number.isFinite(amount) && amount < 0)
      .map((amount) => Math.abs(amount)),
  );
  $("#import-preview").innerHTML =
    `<table class="import-table"><thead><tr><th>Include</th><th>Date</th><th>Vendor</th><th>Amount</th><th>Type</th><th>Category</th><th>Optional description</th></tr></thead><tbody>${rows
      .map((row, i) => {
        const moneyCell = importRowMoney(row, index);
        const amount = moneyCell.amount;
        const dateCell = normalizeImportDate(
          index.date >= 0 ? row[index.date] : "",
          selectedDateOrder,
          inferredDateOrder,
        );
        const postedDateCell =
          index.postedDate >= 0 && String(row[index.postedDate] ?? "").trim()
            ? normalizeImportDate(
                row[index.postedDate],
                selectedDateOrder,
                inferredDateOrder,
              )
            : { value: "", error: "" };
        const rowError =
          moneyCell.error || dateCell.error || postedDateCell.error;
        const vendor = row[index.vendor] ?? "";
        let type = inferImportType(amount, vendor);
        if (type === "income" && outgoingAmounts.has(Math.abs(amount)))
          type = "refund";
        const categoryKind = type === "refund" ? "expense" : type;
        const matching = state.categories.filter(
          (category) => category.active !== 0 && category.kind === categoryKind,
        );
        const suggested = state.categorySuggestions[i]?.categoryId;
        const fallback =
          matching.find((item) =>
            item.name.toLowerCase().startsWith("uncategorized"),
          )?.id ??
          matching[0]?.id ??
          "";
        const selectedCategory = matching.some((item) => item.id === suggested)
          ? suggested
          : fallback;
        const dateDisplay = dateCell.error
          ? `<span class="field-error">${escapeHtml(dateCell.error)}</span>`
          : `${escapeHtml(row[index.date] ?? "")}<br><small>→ ${escapeHtml(dateCell.value)}</small>`;
        return `<tr class="${rowError ? "import-row-error" : ""}"><td><input type="checkbox" data-import-row="${i}" ${rowError ? "disabled" : "checked"} /></td><td>${dateDisplay}</td><td>${escapeHtml(vendor)}</td><td>${Number.isFinite(amount) ? `${amount >= 0 ? "+" : "−"}${money.format(Math.abs(amount))}` : `<span class="field-error">${escapeHtml(moneyCell.error)}</span>`}</td><td><select data-import-type="${i}" ${rowError ? "disabled" : ""}>${["expense", "refund", "income", "transfer", "adjustment"].map((value) => `<option ${value === type ? "selected" : ""}>${value}</option>`).join("")}</select></td><td><select data-import-category="${i}" required ${rowError ? "disabled" : ""}><option value="">Choose category</option>${optionList(matching, selectedCategory)}</select></td><td><input data-import-description="${i}" maxlength="500" placeholder="Optional" ${rowError ? "disabled" : ""}/></td></tr>`;
      })
      .join("")}</tbody></table>`;
  $("#import-submit").disabled =
    index.date < 0 ||
    index.vendor < 0 ||
    (index.amount < 0 && index.debit < 0 && index.credit < 0);
  $("#import-status").textContent =
    `Previewing ${rows.length} rows. ${selectedDateOrder === "auto" ? `Detected date order: ${inferredDateOrder === "mdy" ? "month/day/year" : inferredDateOrder === "dmy" ? "day/month/year" : "needs your selection"}.` : "Using your selected date order."} Dates are normalized to YYYY-MM-DD. A mapped Amount column keeps its bank-provided sign.`;
}
async function loadImportSuggestions() {
  if (!state.csv) return;
  const [headers, ...rows] = state.csv.rows;
  const vendorIndex = headers.indexOf($("[name='map-vendor']")?.value);
  if (vendorIndex < 0) return;
  const descriptions = rows.map((row) => row[vendorIndex] ?? "");
  const suggestions = [];
  for (let index = 0; index < descriptions.length; index += 500) {
    const result = await api("/api/v1/category-suggestions", {
      method: "POST",
      body: JSON.stringify({
        descriptions: descriptions.slice(index, index + 500),
      }),
    });
    suggestions.push(...result.data);
  }
  state.categorySuggestions = suggestions;
  renderImportPreview();
  const matched = suggestions.filter((item) => item.categoryId).length;
  $("#import-status").textContent +=
    ` Automatically matched ${matched} of ${rows.length} rows from your rules, past vendors, and common merchant keywords.`;
}

document.addEventListener("click", (event) => {
  const netWorthSeries = event.target.closest?.("[data-networth-series]");
  if (netWorthSeries) {
    state.selectedNetWorthSeries = netWorthSeries.dataset.networthSeries;
    renderAccountNetWorthChart();
    return;
  }
  const masterTarget = event.target.closest?.("[data-master-id]");
  if (masterTarget) {
    selectMasterCategory(masterTarget.dataset.masterId);
    return;
  }
  const categoryTrendTarget = event.target.closest?.("[data-trend-category]");
  if (categoryTrendTarget) {
    selectActivityTrend(
      "category",
      categoryTrendTarget.dataset.trendCategory,
      categoryTrendTarget.dataset.trendLabel,
    );
    return;
  }
  const accountTrendTarget = event.target.closest?.("[data-trend-account]");
  if (accountTrendTarget) {
    selectActivityTrend(
      "account",
      accountTrendTarget.dataset.trendAccount,
      accountTrendTarget.dataset.trendLabel,
    );
    return;
  }
  const transactionCheckbox = event.target.closest?.(".transaction-select");
  if (transactionCheckbox && state.bulkEditMode) {
    const index = state.transactions.findIndex(
      (item) => item.id === transactionCheckbox.dataset.id,
    );
    selectTransactionAt(index, transactionCheckbox.checked, event.shiftKey);
    return;
  }
  const transactionRow = event.target.closest?.("[data-transaction-row]");
  if (
    transactionRow &&
    state.bulkEditMode &&
    !event.target.closest("button,input,select,a")
  ) {
    const index = state.transactions.findIndex(
      (item) => item.id === transactionRow.dataset.transactionRow,
    );
    selectTransactionAt(
      index,
      !state.selectedTransactionIds.has(transactionRow.dataset.transactionRow),
      event.shiftKey,
    );
    return;
  }
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.cashflowSelectAll || target.dataset.cashflowClear) {
    const kind =
      target.dataset.cashflowSelectAll || target.dataset.cashflowClear;
    state.cashFlowSelections[kind] = target.dataset.cashflowSelectAll
      ? new Set(state.cashFlowData[`${kind}Series`].map((row) => row.id))
      : new Set();
    renderCashFlowFilters();
    drawCashFlowChart();
    return;
  }
  if (target.dataset.themePreset) {
    applyWebsiteColors(themePresets[target.dataset.themePreset]);
    return;
  }
  if (target.id === "reset-website-colors") {
    applyWebsiteColors(defaultWebsiteColors);
    return;
  }
  if (target.id === "clear-master-filter") {
    state.selectedMasterCategoryId = null;
    state.activityTrendSelection = {
      kind: "all",
      id: null,
      label: `All ${state.activityMode === "expense" ? "expenses" : "income"}`,
    };
    renderSpendingBreakdown();
    renderFilteredActivityCards();
    void loadTrend();
    return;
  }
  if (target.id === "clear-activity-trend-filter") {
    state.activityTrendSelection = {
      kind: state.selectedMasterCategoryId ? "master" : "all",
      id: state.selectedMasterCategoryId,
      label: state.selectedMasterCategoryId
        ? (state.summary.activity[state.activityMode].byMasterCategory.find(
            (row) => masterKey(row.id) === state.selectedMasterCategoryId,
          )?.name ?? "Master category")
        : `All ${state.activityMode === "expense" ? "expenses" : "income"}`,
    };
    renderCategoryRanking();
    renderFilteredActivityCards();
    void loadTrend();
    return;
  }
  if (target.id === "nav-toggle") {
    if (mobileNavigation()) setMobileNavigation(false);
    else {
      const collapsed = !document.body.classList.contains("nav-collapsed");
      setNavigationCollapsed(collapsed);
      try {
        window.localStorage.setItem(NAV_STORAGE_KEY, String(collapsed));
      } catch {
        // The menu still works when storage is unavailable.
      }
    }
    return;
  }
  if (target.id === "mobile-nav-toggle") {
    setMobileNavigation(!document.body.classList.contains("nav-open"));
    return;
  }
  if (target.id === "sidebar-backdrop") {
    setMobileNavigation(false);
    return;
  }
  if (target.dataset.activityMode) {
    setActivityMode(target.dataset.activityMode);
    return;
  }
  if (target.id === "bulk-edit-toggle") {
    setBulkEditMode(!state.bulkEditMode);
    return;
  }
  if (target.id === "cancel-bulk-edit") {
    setBulkEditMode(false);
    return;
  }
  if (target.id === "select-page-transactions") {
    state.transactions.forEach((item) =>
      state.selectedTransactionIds.add(item.id),
    );
    void loadTransactions();
    return;
  }
  if (target.id === "select-filtered-transactions") {
    void run(async () => {
      const result = await api(
        `/api/v1/transactions/selection?${currentTransactionFilters()}`,
      );
      state.selectedTransactionIds = new Set(result.data);
      notify(`${result.data.length} filtered transactions selected.`);
      await loadTransactions();
    });
    return;
  }
  if (target.id === "apply-bulk-edit") {
    void run(async () => {
      const changes = {};
      for (const [key, selector] of [
        ["accountId", "#bulk-account"],
        ["categoryId", "#bulk-category"],
        ["transactionType", "#bulk-type"],
      ])
        if ($(selector).value) changes[key] = $(selector).value;
      if (!Object.keys(changes).length)
        return notify("Choose at least one field to change.", true);
      const count = state.selectedTransactionIds.size;
      if (!confirm(`Apply these changes to ${count} transactions?`)) return;
      await api("/api/v1/transactions/bulk", {
        method: "PATCH",
        body: JSON.stringify({
          ids: [...state.selectedTransactionIds],
          changes,
        }),
      });
      notify(`${count} transactions updated.`);
      setBulkEditMode(false);
    });
    return;
  }
  if (target.id === "delete-bulk-transactions") {
    void run(async () => {
      const ids = [...state.selectedTransactionIds];
      if (!confirm(`Permanently delete ${ids.length} selected transactions?`))
        return;
      await api("/api/v1/transactions/bulk", {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      notify(`${ids.length} transactions deleted.`);
      setBulkEditMode(false);
      await loadTransactions();
    });
    return;
  }
  if (target.dataset.accountSelection) {
    const accounts = timelineAccounts();
    state.selectedNetWorthAccounts = new Set(
      accounts
        .filter((account) => {
          if (target.dataset.accountSelection === "all") return true;
          if (target.dataset.accountSelection === "none") return false;
          const liability = ["liability", "credit_card"].includes(
            account.accountType,
          );
          if (target.dataset.accountSelection === "liabilities")
            return liability;
          if (target.dataset.accountSelection === "assets") return !liability;
          return account.liquidityClass === target.dataset.accountSelection;
        })
        .map((account) => account.id),
    );
    renderNetWorthAccountControls();
    renderAccountNetWorthChart();
    renderNetWorthRelatedLists();
    return;
  }
  if (target.dataset.dialog) {
    const dialog = $(`#${target.dataset.dialog}`);
    if (target.dataset.dialog === "transaction-dialog") {
      $("#transaction-form").reset();
      $("#transaction-form").elements.id.value = "";
      $("#transaction-form").transactionDate.value = today();
      $("#transaction-title").textContent = "Add transaction";
      refreshTransactionCategoryOptions("expense");
    }
    if (target.dataset.dialog === "account-dialog") {
      $("#account-form").reset();
      $("#account-form").elements.id.value = "";
      $("#account-title").textContent = "Add account";
    }
    if (target.dataset.dialog === "projection-rule-dialog") {
      $("#projection-rule-form").reset();
      $("#projection-rule-form").elements.id.value = "";
      $("#projection-rule-form").elements.startDate.value = tomorrow();
      $("#projection-rule-title").textContent = "Add Projection Rule";
      updateProjectionRuleFields();
    }
    if (target.dataset.dialog === "balance-dialog") {
      const form = $("#balance-form");
      form.reset();
      form.elements.id.value = "";
      form.elements.snapshotDate.value = today();
      $("#balance-title").textContent = "Record balance";
      const selected = [...state.selectedNetWorthAccounts];
      if (selected.length === 1) form.elements.accountId.value = selected[0];
    }
    if (target.closest("summary")) event.preventDefault();
    dialog.showModal();
  }
  if (target.hasAttribute("data-close")) target.closest("dialog").close();
  if (target.classList.contains("edit-transaction")) {
    const item = state.transactions.find((row) => row.id === target.dataset.id),
      form = $("#transaction-form");
    for (const [key, value] of Object.entries(item))
      if (form.elements[key])
        form.elements[key].value = key === "amount" ? dollars(value) : value;
    form.elements.id.value = item.id;
    form.amount.value = dollars(item.amountMinor);
    refreshTransactionCategoryOptions(item.transactionType, item.categoryId);
    form.accountId.value = item.accountId;
    $("#transaction-title").textContent = "Edit transaction";
    $("#transaction-dialog").showModal();
  }
  if (target.classList.contains("edit-account")) {
    const item = state.accounts.find((row) => row.id === target.dataset.id);
    const form = $("#account-form");
    form.elements.id.value = item.id;
    form.elements.name.value = item.name;
    form.elements.accountType.value = item.accountType;
    form.elements.liquidityClass.value = item.liquidityClass ?? "liquid";
    form.elements.annualInterest.value =
      Number(item.annualInterestBps ?? 0) / 100;
    form.elements.paymentAmount.value = dollars(item.paymentAmountMinor);
    form.elements.paymentFrequency.value = item.paymentFrequency ?? "none";
    form.elements.annualEquityGain.value = dollars(item.annualEquityGainMinor);
    form.elements.annualDividend.value = dollars(item.annualDividendMinor);
    form.elements.projectionNotes.value = item.projectionNotes ?? "";
    $("#account-title").textContent = "Edit account";
    $("#account-dialog").showModal();
  }
  if (target.classList.contains("edit-projection-rule")) {
    const rule = state.projectionRules?.find(
      (row) => row.id === target.dataset.id,
    );
    if (rule) {
      const form = $("#projection-rule-form");
      form.elements.id.value = rule.id;
      form.elements.description.value = rule.description;
      form.elements.ruleType.value = rule.ruleType;
      form.elements.amount.value = dollars(rule.amountMinor);
      form.elements.frequency.value = rule.frequency;
      form.elements.startDate.value = rule.startDate;
      form.elements.endDate.value = rule.endDate ?? "";
      updateProjectionRuleFields();
      form.elements.fromAccountId.value = rule.fromAccountId ?? "";
      form.elements.toAccountId.value = rule.toAccountId ?? "";
      $("#projection-rule-title").textContent = "Edit Projection Rule";
      $("#projection-rule-dialog").showModal();
    }
    return;
  }
  if (target.classList.contains("edit-balance")) {
    const item = state.balanceSnapshots.find(
      (row) => row.id === target.dataset.id,
    );
    if (item) {
      const form = $("#balance-form");
      form.elements.id.value = item.id;
      form.elements.accountId.value = item.accountId;
      form.elements.snapshotDate.value = item.snapshotDate;
      form.elements.balance.value = dollars(item.balanceMinor);
      form.elements.note.value = item.note ?? "";
      $("#balance-title").textContent = "Edit balance";
      $("#balance-dialog").showModal();
    }
    return;
  }
  if (
    target.classList.contains("delete-transaction") &&
    confirm("Delete this transaction? This cannot be undone.")
  )
    void run(async () => {
      await api(`/api/v1/transactions/${target.dataset.id}`, {
        method: "DELETE",
      });
      notify("Transaction deleted.");
      await loadTransactions();
    });
  if (
    target.classList.contains("delete-balance") &&
    confirm("Delete this account balance entry?")
  )
    void run(async () => {
      await api(`/api/v1/balance-snapshots/${target.dataset.id}`, {
        method: "DELETE",
      });
      notify("Account balance deleted.");
      await loadNetWorth();
    });
  if (
    target.classList.contains("archive") &&
    confirm("Archive this item? Existing records will keep it.")
  )
    void run(async () => {
      await api(`/api/v1/${target.dataset.kind}/${target.dataset.id}`, {
        method: "DELETE",
      });
      await loadLookups();
      notify("Item archived.");
    });
  if (
    target.classList.contains("archive-master") &&
    confirm(
      "Archive this master category? Detailed categories will remain available.",
    )
  )
    void run(async () => {
      await api(`/api/v1/master-categories/${target.dataset.id}`, {
        method: "DELETE",
      });
      await loadLookups();
      notify("Master category archived.");
    });
  if (
    target.classList.contains("archive-rule") &&
    confirm("Archive this automatic category rule?")
  )
    void run(async () => {
      await api(`/api/v1/category-rules/${target.dataset.id}`, {
        method: "DELETE",
      });
      await loadLookups();
      notify("Category rule archived.");
    });
  if (
    target.classList.contains("delete-projection-rule") &&
    confirm("Delete this projection rule?")
  )
    void run(async () => {
      await api(`/api/v1/projection-rules/${target.dataset.id}`, {
        method: "DELETE",
      });
      notify("Projection rule deleted.");
      await loadNetWorth();
    });
});

document.addEventListener("change", (event) => {
  const cashFlowOption = event.target.closest?.("[data-cashflow-kind]");
  if (cashFlowOption) {
    const selected =
      state.cashFlowSelections[cashFlowOption.dataset.cashflowKind];
    if (cashFlowOption.checked) selected.add(cashFlowOption.value);
    else selected.delete(cashFlowOption.value);
    renderCashFlowFilters();
    drawCashFlowChart();
    return;
  }
  if (event.target.id === "cashflow-color-by") {
    state.cashFlowColorBy = event.target.value;
    drawCashFlowChart();
    return;
  }
  if (event.target.closest?.("#website-colors-form")) {
    applyWebsiteColors(
      Object.fromEntries(new FormData($("#website-colors-form"))),
    );
    return;
  }
  const accountToggle = event.target.closest?.("[data-networth-account]");
  if (accountToggle) {
    if (accountToggle.checked)
      state.selectedNetWorthAccounts.add(accountToggle.dataset.networthAccount);
    else
      state.selectedNetWorthAccounts.delete(
        accountToggle.dataset.networthAccount,
      );
    renderAccountNetWorthChart();
    renderNetWorthRelatedLists();
    return;
  }
  const assignment = event.target.closest(".master-category-assignment");
  if (assignment) {
    void run(async () => {
      await api(
        `/api/v1/categories/${assignment.dataset.categoryId}/master-category`,
        {
          method: "PUT",
          body: JSON.stringify({ masterCategoryId: assignment.value || null }),
        },
      );
      notify("Master category assignment saved.");
    });
    return;
  }
  if (event.target.matches("#projection-rule-form [name='ruleType']")) {
    updateProjectionRuleFields();
    return;
  }
  if (event.target.matches("#transaction-form [name='transactionType']")) {
    refreshTransactionCategoryOptions(event.target.value);
    return;
  }
  const typeSelect = event.target.closest("[data-import-type]");
  if (!typeSelect) return;
  const categorySelect = $(
    `[data-import-category="${typeSelect.dataset.importType}"]`,
  );
  const matching = state.categories.filter(
    (category) =>
      category.active !== 0 &&
      category.kind ===
        (typeSelect.value === "refund" ? "expense" : typeSelect.value),
  );
  const fallback =
    matching.find((item) => item.name.toLowerCase().startsWith("uncategorized"))
      ?.id ?? matching[0]?.id;
  categorySelect.innerHTML = `<option value="">Choose category</option>${optionList(matching, fallback)}`;
});

document.addEventListener("keydown", (event) => {
  const series = event.target.closest?.("[data-networth-series]");
  if (series && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    state.selectedNetWorthSeries = series.dataset.networthSeries;
    renderAccountNetWorthChart();
    return;
  }
  const target = event.target.closest?.(".donut-slice[data-master-id]");
  if (target && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectMasterCategory(target.dataset.masterId);
  }
  const category = event.target.closest?.("[data-trend-category]");
  if (category && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectActivityTrend(
      "category",
      category.dataset.trendCategory,
      category.dataset.trendLabel,
    );
  }
});
for (const eventName of ["mouseover", "focusin", "click"])
  document.addEventListener(eventName, (event) => {
    const target = event.target.closest?.(".account-hover-target");
    if (target)
      showNetWorthAccountDetail(
        target.dataset.accountId,
        Number(target.dataset.pointIndex),
      );
  });

$("#transaction-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement),
      id = form.get("id"),
      body = {
        transactionDate: form.get("transactionDate"),
        transactionType: form.get("transactionType"),
        transactionDirection: transactionDirectionForType(
          form.get("transactionType"),
        ),
        categoryId: form.get("categoryId"),
        accountId: form.get("accountId"),
        vendorName: form.get("vendorName"),
        description: form.get("description"),
        amountMinor: cents(form.get("amount")),
        currency: "CAD",
      };
    await api(id ? `/api/v1/transactions/${id}` : "/api/v1/transactions", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#transaction-dialog").close();
    notify(id ? "Transaction updated." : "Transaction added.");
    await loadTransactions();
  });
});
$("#balance-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement);
    const id = form.get("id");
    await api(
      id ? `/api/v1/balance-snapshots/${id}` : "/api/v1/balance-snapshots",
      {
        method: id ? "PUT" : "POST",
        body: JSON.stringify({
          accountId: form.get("accountId"),
          snapshotDate: form.get("snapshotDate"),
          balanceMinor: cents(form.get("balance")),
          note: form.get("note"),
        }),
      },
    );
    $("#balance-dialog").close();
    notify(id ? "Balance updated." : "Balance recorded.");
    await loadNetWorth();
  });
});
$("#projection-rule-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement);
    const id = form.get("id");
    await api(
      id ? `/api/v1/projection-rules/${id}` : "/api/v1/projection-rules",
      {
        method: id ? "PUT" : "POST",
        body: JSON.stringify({
          description: form.get("description"),
          ruleType: form.get("ruleType"),
          amountMinor: cents(form.get("amount")),
          frequency: form.get("frequency"),
          startDate: form.get("startDate"),
          endDate: form.get("endDate") || null,
          fromAccountId: form.get("fromAccountId") || null,
          toAccountId: form.get("toAccountId") || null,
        }),
      },
    );
    $("#projection-rule-dialog").close();
    formElement.reset();
    notify(id ? "Projection rule updated." : "Projection rule added.");
    await loadNetWorth();
  });
});
$("#category-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    await api("/api/v1/categories", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(formElement))),
    });
    formElement.reset();
    await loadLookups();
    notify("Category added.");
  });
});
$("#master-category-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    await api("/api/v1/master-categories", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(formElement))),
    });
    formElement.reset();
    await loadLookups();
    notify("Master category added.");
  });
});
$("#category-rule-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement);
    await api("/api/v1/category-rules", {
      method: "POST",
      body: JSON.stringify({
        pattern: form.get("pattern"),
        categoryId: form.get("categoryId"),
        priority: Number(form.get("priority")),
      }),
    });
    formElement.reset();
    await loadLookups();
    notify("Automatic category rule added.");
  });
});
$("#website-colors-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const colors = Object.fromEntries(new FormData(formElement));
    if (
      colorContrast(colors.textColor, colors.backgroundColor) < 4.5 ||
      colorContrast(colors.textColor, colors.cardColor) < 4.5
    )
      throw new Error(
        "Text must have readable contrast against both the page and card colors. Choose a darker text color or lighter backgrounds.",
      );
    const result = await api("/api/v1/website-preferences", {
      method: "PUT",
      body: JSON.stringify(colors),
    });
    applyWebsiteColors(result.data);
    notify("Website colors saved to your account.");
  });
});
$("#account-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement);
    const id = form.get("id");
    const body = {
      name: form.get("name"),
      accountType: form.get("accountType"),
      liquidityClass: form.get("liquidityClass"),
      annualGrowthBps: 0,
      paymentAmountMinor: cents(form.get("paymentAmount")),
      paymentFrequency: form.get("paymentFrequency"),
      annualInterestBps: Math.round(Number(form.get("annualInterest")) * 100),
      annualEquityGainMinor: cents(form.get("annualEquityGain")),
      annualDividendMinor: cents(form.get("annualDividend")),
      annualDepreciationBps: 0,
      projectionNotes: form.get("projectionNotes"),
    };
    await api(id ? `/api/v1/accounts/${id}` : "/api/v1/accounts", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#account-dialog").close();
    await loadLookups();
    notify(id ? "Account updated." : "Account added.");
  });
});
$("#budget-form").addEventListener("input", updateBudgetTotals);
$("#budget-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const button = formElement.querySelector("button");
    button.disabled = true;
    try {
      const items = $$("[data-budget-id]").map((input) => ({
        categoryId: input.dataset.budgetId,
        monthlyBudgetMinor: cents(input.value || 0),
      }));
      await api("/api/v1/budgets", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
      state.categories.forEach((category) => {
        const input = $(`[data-budget-id="${category.id}"]`);
        if (input) category.monthlyBudgetMinor = cents(input.value || 0);
      });
      notify("Monthly budget saved.");
    } finally {
      button.disabled = false;
    }
  });
});
$("#import-form").file.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const rows = normalizeCsvRows(parseCsv(await file.text()));
  if (rows.length < 2) return notify("The CSV has no transaction rows.", true);
  state.csv = { fileName: file.name, rows };
  state.categorySuggestions = [];
  const headers = rows[0];
  $("#mapping").innerHTML =
    mappingSelect("Date", headers, ["transaction date", "date"]) +
    mappingSelect("Posted Date", headers, ["posted date", "posting date"]) +
    mappingSelect("Transaction ID", headers, [
      "transaction id",
      "transaction number",
      "reference number",
      "confirmation number",
    ]) +
    mappingSelect("Vendor", headers, [
      "description",
      "merchant",
      "vendor",
      "payee",
    ]) +
    mappingSelect("Amount", headers, ["amount"]) +
    mappingSelect("Debit", headers, [
      "debit",
      "expense",
      "withdrawal",
      "money out",
      "paid out",
    ]) +
    mappingSelect("Credit", headers, [
      "credit",
      "income",
      "deposit",
      "money in",
      "paid in",
    ]) +
    `<label>Date format<select name="date-format"><option value="auto">Auto-detect</option><option value="mdy">Month/day/year</option><option value="dmy">Day/month/year</option></select></label>`;
  $("#mapping").hidden = false;
  $$("select", $("#mapping")).forEach((select) =>
    select.addEventListener(
      "change",
      () =>
        void run(async () => {
          renderImportPreview();
          await loadImportSuggestions();
        }),
    ),
  );
  renderImportPreview();
  await run(loadImportSuggestions);
});
$("#import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const [headers, ...sourceRows] = state.csv.rows,
      form = new FormData(formElement),
      selected = new Set(
        $$("[data-import-row]:checked").map((input) =>
          Number(input.dataset.importRow),
        ),
      ),
      key = (name) => headers.indexOf(form.get(`map-${name}`)),
      importIndex = importMapping(headers);
    const selectedDateOrder = form.get("date-format") ?? "auto";
    const inferredDateOrder = inferDateOrder(
      sourceRows.map((row) =>
        importIndex.date >= 0 ? row[importIndex.date] : "",
      ),
    );
    const missingCategory = [...selected].find(
      (index) => !$(`[data-import-category="${index}"]`).value,
    );
    if (missingCategory !== undefined)
      throw new Error(
        `Choose a category for included row ${missingCategory + 1}.`,
      );
    if (!selected.size)
      throw new Error(
        "No valid rows are selected. Correct the date format or amount mappings and try again.",
      );
    const occurrenceCounts = new Map(),
      occurrenceNumbers = sourceRows.map((row, originalIndex) => {
        const moneyCell = importRowMoney(row, importIndex),
          rawAmount = moneyCell.amount,
          transactionType = $(`[data-import-type="${originalIndex}"]`).value,
          direction = moneyCell.direction,
          postedDate =
            importIndex.postedDate >= 0 && row[importIndex.postedDate]
              ? normalizeImportDate(
                  row[importIndex.postedDate],
                  selectedDateOrder,
                  inferredDateOrder,
                ).value
              : "",
          transactionDate = normalizeImportDate(
            row[key("date")],
            selectedDateOrder,
            inferredDateOrder,
          ).value,
          occurrenceKey = JSON.stringify([
            postedDate,
            transactionDate,
            row[key("vendor")],
            cents(Math.abs(rawAmount)),
            transactionType,
            direction,
            JSON.stringify(row),
          ]),
          occurrenceNumber = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
        occurrenceCounts.set(occurrenceKey, occurrenceNumber);
        return occurrenceNumber;
      });
    const rows = sourceRows.flatMap((row, originalIndex) => {
      if (!selected.has(originalIndex)) return [];
      const moneyCell = importRowMoney(row, importIndex),
        rawAmount = moneyCell.amount,
        transactionType = $(`[data-import-type="${originalIndex}"]`).value,
        direction = moneyCell.direction,
        transactionDate = normalizeImportDate(
          row[key("date")],
          selectedDateOrder,
          inferredDateOrder,
        ).value,
        postedDate =
          importIndex.postedDate >= 0 && row[importIndex.postedDate]
            ? normalizeImportDate(
                row[importIndex.postedDate],
                selectedDateOrder,
                inferredDateOrder,
              ).value
            : "",
        sourceTransactionId =
          importIndex.transactionId >= 0 ? row[importIndex.transactionId] : "",
        sourceRow = JSON.stringify(row);
      return [
        {
          transactionDate,
          postedDate,
          sourceTransactionId,
          sourceRow,
          occurrenceNumber: occurrenceNumbers[originalIndex],
          vendorName: row[key("vendor")],
          description: $(
            `[data-import-description="${originalIndex}"]`,
          ).value.trim(),
          amountMinor: cents(Math.abs(rawAmount)),
          balanceEffectMinor: cents(
            Math.abs(rawAmount) * (direction === "credit" ? 1 : -1),
          ),
          categoryId: $(`[data-import-category="${originalIndex}"]`).value,
          transactionType,
          transactionDirection: direction,
          currency: "CAD",
        },
      ];
    });
    const totals = { accepted: 0, duplicates: 0, rejected: 0, errors: [] };
    for (let index = 0; index < rows.length; index += 40) {
      const result = await api("/api/v1/imports", {
        method: "POST",
        body: JSON.stringify({
          fileName: state.csv.fileName,
          accountId: form.get("accountId"),
          rows: rows.slice(index, index + 40),
        }),
      });
      totals.accepted += result.data.accepted;
      totals.duplicates += result.data.duplicates;
      totals.rejected += result.data.rejected;
      totals.errors.push(
        ...result.data.errors.map((error) => ({
          ...error,
          row: error.row + index,
        })),
      );
    }
    const summary = `Imported ${totals.accepted}; skipped ${totals.duplicates} duplicates; rejected ${totals.rejected}.`;
    if (totals.rejected) {
      const details = totals.errors
        .slice(0, 8)
        .map((item) => `Row ${item.row}: ${item.message}`)
        .join(" ");
      $("#import-status").textContent =
        `${summary} ${details}${totals.errors.length > 8 ? ` Plus ${totals.errors.length - 8} more row errors.` : ""}`;
      notify(
        "The import completed with row errors. Review the details in the import window.",
        true,
      );
    } else {
      $("#import-dialog").close();
      notify(summary);
    }
    await loadTransactions();
  });
});
$("#apply-filters").addEventListener("click", () => {
  state.page = 1;
  void run(loadTransactions);
});
$("#previous-page").addEventListener("click", () => {
  state.page -= 1;
  void run(loadTransactions);
});
$("#next-page").addEventListener("click", () => {
  state.page += 1;
  void run(loadTransactions);
});
$("#apply-summary-range").addEventListener(
  "click",
  () => void run(loadSummary),
);
$("#apply-networth-range").addEventListener(
  "click",
  () => void run(loadNetWorth),
);
window.addEventListener("hashchange", () => void showView());
$("#show-login").addEventListener("click", () => {
  $("#login-form").hidden = false;
  $("#register-form").hidden = true;
  $("#show-login").classList.remove("secondary");
  $("#show-register").classList.add("secondary");
  $("#auth-error").hidden = true;
});
$("#show-register").addEventListener("click", () => {
  $("#login-form").hidden = true;
  $("#register-form").hidden = false;
  $("#show-login").classList.add("secondary");
  $("#show-register").classList.remove("secondary");
  $("#auth-error").hidden = true;
});
for (const [formId, endpoint] of [
  ["login-form", "/api/v1/auth/login"],
  ["register-form", "/api/v1/auth/register"],
])
  $(`#${formId}`).addEventListener("submit", (event) => {
    event.preventDefault();
    // A DOM event's `currentTarget` is only guaranteed while the synchronous
    // listener is running. Capture the form before awaiting the API request so
    // later calls such as `reset()` never dereference a cleared event target.
    const formElement = event.currentTarget;
    void (async () => {
      const button = formElement.querySelector("button[type='submit']");
      button.disabled = true;
      $("#auth-error").hidden = true;
      try {
        const form = new FormData(formElement);
        const result = await api(endpoint, {
          method: "POST",
          body: JSON.stringify({
            username: form.get("username"),
            password: form.get("password"),
            keepSignedIn: form.get("keepSignedIn") === "on",
          }),
        });
        try {
          if (result.data.pageSessionKey)
            window.sessionStorage.setItem(
              PAGE_SESSION_KEY,
              result.data.pageSessionKey,
            );
          else window.sessionStorage.removeItem(PAGE_SESSION_KEY);
        } catch {
          throw new Error(
            "This browser must allow session storage to use a short sign-in.",
          );
        }
        formElement.reset();
        await enterApp(result.data);
      } catch (error) {
        showAuth(error instanceof Error ? error.message : "Sign-in failed.");
      } finally {
        button.disabled = false;
      }
    })();
  });
// Password visibility is a presentation-only feature. The value never leaves
// the input except through the normal encrypted HTTPS login/register request.
$$(".password-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.closest(".password-field").querySelector("input");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.textContent = showing ? "Eye" : "Hide";
    button.setAttribute(
      "aria-label",
      showing ? "Show password" : "Hide password",
    );
    button.setAttribute("aria-pressed", String(!showing));
  });
});
$("#logout").addEventListener("click", () => {
  void (async () => {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } finally {
      try {
        window.sessionStorage.removeItem(PAGE_SESSION_KEY);
      } catch {
        // The server-side session was still destroyed.
      }
      state.categories = [];
      state.accounts = [];
      showAuth();
    }
  })();
});
$("#settings").addEventListener(
  "toggle",
  (event) => {
    const opened = event.target.closest("details[open]");
    if (!opened) return;
    $$("details[open]", $("#settings")).forEach((detail) => {
      if (detail !== opened) detail.open = false;
    });
  },
  true,
);
$("#transaction-start-date").value = monthStart();
$("#transaction-end-date").value = today();
$("#summary-start-date").value = yearStart();
$("#summary-end-date").value = today();
$("#networth-start-date").value = shiftYears(today(), -2);
$("#networth-end-date").value = shiftYears(today(), 5);
$("#balance-form").snapshotDate.value = today();
try {
  const session = await api("/api/v1/auth/me");
  await enterApp(session.data);
} catch (error) {
  if (error?.status === 401) showAuth();
  else showAuth(error instanceof Error ? error.message : "Unable to start.");
}
