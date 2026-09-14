import assert from "node:assert/strict";
const base = "http://127.0.0.1:8787/api/v1";
let cookie = "",
  pageSessionKey = "";
async function api(path, body, method = body ? "POST" : "GET", status = 200) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "x-page-session": pageSessionKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const value = await response.json();
  if (value.data?.pageSessionKey) pageSessionKey = value.data.pageSessionKey;
  assert.equal(response.status, status, JSON.stringify(value));
  return value.data;
}
await api(
  "/auth/register",
  { username: "SnapshotTest" + Date.now(), password: "LocalTestOnly-7151!" },
  "POST",
  201,
);
const categories = await api("/categories");
const housing = categories.find((row) => row.name === "Housing");
const income = categories.find((row) => row.name === "Work Income");
const save = (date, amount, correction = false) =>
  api(
    "/budgets",
    {
      effectiveDate: date,
      name: "Housing test",
      correction,
      items: [{ categoryId: housing.id, monthlyBudgetMinor: amount }],
    },
    "PUT",
  );
await save("2025-01-01", 100_000);
await save("2026-01-01", 300_000);
const range = "startDate=2025-01-01&endDate=2026-12-31";
const summary = await api("/monthly-summary?" + range);
assert.equal(summary.totalBudgetMinor, 4_800_000);
assert.equal(
  summary.activity.expense.byCategory.find((row) => row.id === housing.id)
    .budget_minor,
  4_800_000,
);
const cash = await api("/cash-flow-trends?" + range);
assert.equal(
  cash.expenseSeries
    .flatMap((row) => row.budgetValues)
    .reduce((a, b) => a + b, 0),
  4_800_000,
);
await api("/budgets", { effectiveDate: "2026-01-01", items: [] }, "PUT", 409);
await save("2026-01-01", 400_000, true);
const history = await api("/budget-history");
assert.equal(
  history.filter((row) => row.effectiveDate === "2026-01-01").length,
  2,
);
await api(
  "/budgets",
  {
    effectiveDate: "2026-06-01",
    items: [{ categoryId: income.id, monthlyBudgetMinor: 500_000 }],
  },
  "PUT",
);
assert.equal(
  (await api("/budgets?effectiveDate=2026-06-01")).find(
    (row) => row.id === housing.id,
  ).monthlyBudgetMinor,
  400_000,
);
await save("2026-09-01", 100_000);
await save("2026-09-15", 300_000);
assert.equal(
  (await api("/monthly-summary?startDate=2026-09-01&endDate=2026-09-30"))
    .totalBudgetMinor,
  206_667,
);
console.log(
  "PASS: normalized snapshots, revisions, partial saves, cross-period totals, charts, and mid-month proration.",
);
