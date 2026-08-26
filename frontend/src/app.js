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

// Central HTTP helper. `credentials: include` sends the protected session
// cookie even when Pages and the Worker use separate approved origins.
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
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
    throw error;
  }
  return payload;
}

// Swap the private application for the sign-in card and display safe errors.
function showAuth(error = "") {
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
  await loadLookups();
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

// Projection length follows the visible graph range instead of exposing a
// second, potentially conflicting "projection months" setting.
function projectionMonthsFromEndDate(endDate) {
  const start = new Date(`${today()}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return 60;
  const approximateMonths = Math.ceil(
    (end.getTime() - start.getTime()) / (30.4375 * 86_400_000),
  );
  return Math.max(1, Math.min(600, approximateMonths));
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
  for (const type of ["expense", "income"]) {
    const select = $(`#${type}-trend-filter`),
      previous = select.value;
    select.innerHTML = trendFilterOptions(type);
    if ([...select.options].some((option) => option.value === previous))
      select.value = previous;
  }
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
    type = $("#transaction-type-filter").value;
  if ($("#transaction-start-date").value)
    params.set("startDate", $("#transaction-start-date").value);
  if ($("#transaction-end-date").value)
    params.set("endDate", $("#transaction-end-date").value);
  if (search) params.set("search", search);
  if (type) params.set("type", type);
  params.set("sort", $("#transaction-sort").value);
  const result = await api(`/api/v1/transactions?${params}`);
  state.transactions = result.data;
  state.total = result.pagination.total;
  $("#transactions-body").innerHTML = state.transactions
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.transactionDate)}</td><td><strong>${escapeHtml(item.vendorName)}</strong><br><small>${escapeHtml(item.description)}</small></td><td>${escapeHtml(item.categoryName)}</td><td>${escapeHtml(item.accountName)}</td><td><span class="pill">${escapeHtml(item.transactionType)}</span></td><td class="money">${money.format(dollars(item.amountMinor))}</td><td><button class="secondary edit-transaction" data-id="${escapeHtml(item.id)}">Edit</button> <button class="secondary danger delete-transaction" data-id="${escapeHtml(item.id)}">Delete</button></td></tr>`,
    )
    .join("");
  $("#transactions-empty").hidden = state.transactions.length > 0;
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $("#page-label").textContent = `Page ${state.page} of ${pages}`;
  $("#previous-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pages;
}
function drawBars(selector, rows) {
  const max = Math.max(1, ...rows.map((row) => row.amountMinor));
  $(selector).innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<div class="bar-row"><span>${escapeHtml(row.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (row.amountMinor / max) * 100)}%"></div></div><strong>${money.format(dollars(row.amountMinor))}</strong></div>`,
        )
        .join("")
    : '<div class="empty">No spending this month.</div>';
}
async function loadSummary() {
  const range = new URLSearchParams({
    startDate: $("#summary-start-date").value,
    endDate: $("#summary-end-date").value,
  });
  const result = await api(`/api/v1/monthly-summary?${range}`);
  const data = result.data;
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
  drawBars(
    "#master-category-bars",
    data.byMasterCategory.map((row) => ({
      ...row,
      amountMinor: row.amount_minor,
    })),
  );
  drawBars(
    "#category-bars",
    data.byCategory.map((row) => ({ ...row, amountMinor: row.amount_minor })),
  );
  drawBars(
    "#account-bars",
    data.byAccount.map((row) => ({ ...row, amountMinor: row.amount_minor })),
  );
  $("#category-budget-status").innerHTML = data.byCategory.length
    ? data.byCategory
        .map((row) => {
          const periodBudget =
            Number(row.monthly_budget_minor ?? 0) * data.monthCount;
          const remaining = periodBudget - row.amount_minor;
          const percent = periodBudget
            ? Math.round((row.amount_minor / periodBudget) * 100)
            : null;
          return `<div class="budget-row ${remaining < 0 ? "is-over" : ""}"><span>${escapeHtml(row.name)}</span><span>Actual ${money.format(dollars(row.amount_minor))}</span><span>Budget ${money.format(dollars(periodBudget))}</span><strong>${periodBudget ? `${percent}% · ${remaining < 0 ? "Over" : "Left"} ${money.format(dollars(Math.abs(remaining)))}` : "No budget set"}</strong></div>`;
        })
        .join("")
    : '<div class="empty">No expense activity in this range.</div>';
  await Promise.all([loadTrend("expense"), loadTrend("income")]);
}

function trendFilterOptions(type) {
  const categories = state.categories.filter(
    (item) => item.active !== 0 && item.kind === type,
  );
  return `<option value="all">All ${type === "expense" ? "expenses" : "income"}</option><optgroup label="Master categories">${optionList(state.masterCategories).replaceAll('value="', 'value="master:')}</optgroup><optgroup label="Categories">${optionList(categories).replaceAll('value="', 'value="category:')}</optgroup>`;
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
async function loadTrend(type) {
  const selector = $(`#${type}-trend-filter`),
    value = selector.value || "all";
  const params = new URLSearchParams({
    startDate: $("#summary-start-date").value,
    endDate: $("#summary-end-date").value,
    type,
  });
  if (value.startsWith("category:")) params.set("categoryId", value.slice(9));
  if (value.startsWith("master:"))
    params.set("masterCategoryId", value.slice(7));
  const result = await api(`/api/v1/spending-trends?${params}`);
  drawTrend(`#${type}-trend-chart`, result.data);
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
  const [balances, projection, timeline, purchases] = await Promise.all([
    api("/api/v1/balance-snapshots"),
    api("/api/v1/projection"),
    api(`/api/v1/net-worth-timeline?${range}`),
    api("/api/v1/future-purchases"),
  ]);
  const latest = new Map();
  balances.data.forEach((row) => latest.set(row.accountId, row));
  $("#balances-body").innerHTML = balances.data
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.snapshotDate)}</td><td>${escapeHtml(row.accountName)}</td><td>${escapeHtml(row.accountType)}</td><td class="money">${money.format(dollars(row.balanceMinor))}</td></tr>`,
    )
    .join("");
  const assets = projection.data.startAssetsMinor,
    liabilities = projection.data.startLiabilitiesMinor;
  $("#assets-total").textContent = money.format(dollars(assets));
  $("#liabilities-total").textContent = money.format(dollars(liabilities));
  $("#networth-total").textContent = money.format(
    dollars(assets - liabilities),
  );
  const form = $("#projection-form"),
    assumptions = projection.data.assumptions;
  form.monthlyIncome.value = dollars(assumptions.monthlyIncomeMinor);
  form.monthlyExpense.value = dollars(assumptions.monthlyExpenseMinor);
  form.monthlySavings.value = dollars(assumptions.monthlySavingsMinor);
  $("#future-purchases-list").innerHTML = purchases.data.length
    ? purchases.data
        .map(
          (item) =>
            `<div class="future-purchase"><span><strong>${escapeHtml(item.purchaseDate)}</strong> · ${escapeHtml(item.description)} · ${escapeHtml(item.accountName)}</span><span>${money.format(dollars(item.amountMinor))} <button class="secondary danger delete-future-purchase" data-id="${escapeHtml(item.id)}">Delete</button></span></div>`,
        )
        .join("")
    : '<div class="empty">No planned purchases.</div>';
  const points = timeline.data.points;
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
}

async function showView() {
  const id = window.location.hash.slice(1) || "transactions";
  $$(".view").forEach((view) => {
    view.hidden = view.id !== id;
  });
  $$(".topbar nav a").forEach((link) =>
    link.classList.toggle("active", link.hash === `#${id}`),
  );
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
  return Object.fromEntries(
    keys.map((key) => [key, headers.indexOf($(`[name="map-${key}"]`)?.value)]),
  );
}
function importRowAmount(row, index) {
  if (index.amount >= 0 && row[index.amount] !== "")
    return parseMoney(row[index.amount]);
  const debit = index.debit >= 0 ? parseMoney(row[index.debit]) : 0;
  const credit = index.credit >= 0 ? parseMoney(row[index.credit]) : 0;
  if (Number.isFinite(debit) && debit > 0) return -debit;
  if (Number.isFinite(credit) && credit > 0) return credit;
  return NaN;
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
function renderImportPreview() {
  const [headers, ...rows] = state.csv.rows;
  const index = importMapping(headers);
  $("#import-preview").innerHTML =
    `<table class="import-table"><thead><tr><th>Include</th><th>Date</th><th>Vendor</th><th>Amount</th><th>Type</th><th>Category</th><th>Optional description</th></tr></thead><tbody>${rows
      .map((row, i) => {
        const amount = importRowAmount(row, index);
        const vendor = row[index.vendor] ?? "";
        const type = inferImportType(amount, vendor);
        const matching = state.categories.filter(
          (category) => category.active !== 0 && category.kind === type,
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
        return `<tr><td><input type="checkbox" data-import-row="${i}" checked /></td><td>${escapeHtml(row[index.date] ?? "")}</td><td>${escapeHtml(vendor)}</td><td>${Number.isFinite(amount) ? money.format(Math.abs(amount)) : "Invalid amount"}</td><td><select data-import-type="${i}">${["expense", "income", "transfer", "adjustment"].map((value) => `<option ${value === type ? "selected" : ""}>${value}</option>`).join("")}</select></td><td><select data-import-category="${i}" required><option value="">Choose category</option>${optionList(matching, selectedCategory)}</select></td><td><input data-import-description="${i}" maxlength="500" placeholder="Optional" /></td></tr>`;
      })
      .join("")}</tbody></table>`;
  $("#import-submit").disabled =
    index.date < 0 ||
    index.vendor < 0 ||
    (index.amount < 0 && index.debit < 0 && index.credit < 0);
  $("#import-status").textContent =
    `Previewing ${rows.length} rows. Neo Amount files and headerless CIBC Date/Description/Debit/Credit files are supported. Confirm the suggested type and category; descriptions may stay blank.`;
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
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.dialog) {
    const dialog = $(`#${target.dataset.dialog}`);
    if (target.dataset.dialog === "transaction-dialog") {
      $("#transaction-form").reset();
      $("#transaction-form").elements.id.value = "";
      $("#transaction-form").transactionDate.value = today();
    }
    if (target.dataset.dialog === "account-dialog") {
      $("#account-form").reset();
      $("#account-form").elements.id.value = "";
      $("#account-title").textContent = "Add account";
    }
    if (target.dataset.dialog === "future-purchase-dialog") {
      $("#future-purchase-form").reset();
      const purchaseDate = $("#future-purchase-form").elements.purchaseDate;
      purchaseDate.min = tomorrow();
      purchaseDate.value = shiftYears(today(), 1);
    }
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
    form.categoryId.value = item.categoryId;
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
    target.classList.contains("delete-future-purchase") &&
    confirm("Delete this planned purchase?")
  )
    void run(async () => {
      await api(`/api/v1/future-purchases/${target.dataset.id}`, {
        method: "DELETE",
      });
      notify("Planned purchase deleted.");
      await loadNetWorth();
    });
});

document.addEventListener("change", (event) => {
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
  const typeSelect = event.target.closest("[data-import-type]");
  if (!typeSelect) return;
  const categorySelect = $(
    `[data-import-category="${typeSelect.dataset.importType}"]`,
  );
  const matching = state.categories.filter(
    (category) => category.active !== 0 && category.kind === typeSelect.value,
  );
  const fallback =
    matching.find((item) => item.name.toLowerCase().startsWith("uncategorized"))
      ?.id ?? matching[0]?.id;
  categorySelect.innerHTML = `<option value="">Choose category</option>${optionList(matching, fallback)}`;
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
    await api("/api/v1/balance-snapshots", {
      method: "POST",
      body: JSON.stringify({
        accountId: form.get("accountId"),
        snapshotDate: form.get("snapshotDate"),
        balanceMinor: cents(form.get("balance")),
        note: form.get("note"),
      }),
    });
    $("#balance-dialog").close();
    notify("Balance recorded.");
    await loadNetWorth();
  });
});
$("#future-purchase-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement);
    await api("/api/v1/future-purchases", {
      method: "POST",
      body: JSON.stringify({
        description: form.get("description"),
        amountMinor: cents(form.get("amount")),
        purchaseDate: form.get("purchaseDate"),
        accountId: form.get("accountId"),
      }),
    });
    $("#future-purchase-dialog").close();
    notify("Future purchase added to the projection.");
    await loadNetWorth();
  });
});
$("#projection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  void run(async () => {
    const form = new FormData(formElement);
    await api("/api/v1/projection", {
      method: "PUT",
      body: JSON.stringify({
        monthlyIncomeMinor: cents(form.get("monthlyIncome")),
        monthlyExpenseMinor: cents(form.get("monthlyExpense")),
        monthlySavingsMinor: cents(form.get("monthlySavings")),
        annualAssetGrowthBps: 0,
        annualLiabilityInterestBps: 0,
        horizonMonths: projectionMonthsFromEndDate(
          $("#networth-end-date").value,
        ),
      }),
    });
    notify("Projection assumptions saved.");
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
    mappingSelect("Date", headers, ["date"]) +
    mappingSelect("Vendor", headers, [
      "description",
      "merchant",
      "vendor",
      "payee",
    ]) +
    mappingSelect("Amount", headers, ["amount"]) +
    mappingSelect("Debit", headers, ["debit", "withdrawal"]) +
    mappingSelect("Credit", headers, ["credit", "deposit"]);
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
    const missingCategory = [...selected].find(
      (index) => !$(`[data-import-category="${index}"]`).value,
    );
    if (missingCategory !== undefined)
      throw new Error(
        `Choose a category for included row ${missingCategory + 1}.`,
      );
    const rows = sourceRows
      .filter((_, index) => selected.has(index))
      .map((row, filteredIndex) => {
        const originalIndex = [...selected][filteredIndex];
        return {
          transactionDate: row[key("date")],
          vendorName: row[key("vendor")],
          description: $(
            `[data-import-description="${originalIndex}"]`,
          ).value.trim(),
          amountMinor: cents(Math.abs(importRowAmount(row, importIndex))),
          balanceEffectMinor: cents(importRowAmount(row, importIndex)),
          categoryId: $(`[data-import-category="${originalIndex}"]`).value,
          transactionType: $(`[data-import-type="${originalIndex}"]`).value,
          currency: "CAD",
        };
      });
    const totals = { accepted: 0, duplicates: 0, rejected: 0, errors: [] };
    for (let index = 0; index < rows.length; index += 500) {
      const result = await api("/api/v1/imports", {
        method: "POST",
        body: JSON.stringify({
          fileName: state.csv.fileName,
          accountId: form.get("accountId"),
          rows: rows.slice(index, index + 500),
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
$("#expense-trend-filter").addEventListener(
  "change",
  () => void run(() => loadTrend("expense")),
);
$("#income-trend-filter").addEventListener(
  "change",
  () => void run(() => loadTrend("income")),
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
          }),
        });
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
