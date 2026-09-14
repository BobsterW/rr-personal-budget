// Run only against the isolated local V7.15 Worker after local migrations.
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8787/api/v1";
let cookie = "";
let pageSessionKey = "";
async function api(path, body, method = body ? "POST" : "GET", status = 200) {
  const response = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie, "x-page-session": pageSessionKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  const value = await response.json();
  if (value.data?.pageSessionKey) pageSessionKey = value.data.pageSessionKey;
  assert.equal(response.status, status, JSON.stringify(value));
  return value.data;
}
await api("/auth/register", { username: "SnapshotTest" + Date.now(), password: "LocalTestOnly-715!" }, "POST", 201);
const categories = await api("/categories");
const housing = categories.find(c => c.name === "Housing");
const salary = categories.find(c => c.name === "Work Income");
const save = (date, amount, correction = false) => api("/budgets", { effectiveDate: date, name: "Housing test", correction, items: [{ categoryId: housing.id, monthlyBudgetMinor: amount }] }, "PUT");
await save("2025-01-01", 100000);
await save("2026-01-01", 300000);
const range = "startDate=2025-01-01&endDate=2026-12-31";
const summary = await api("/monthly-summary?" + range);
assert.equal(summary.totalBudgetMinor, 4800000);
assert.equal(summary.activity.expense.byCategory.find(c => c.id === housing.id).budget_minor, 4800000);
const cash = await api("/cash-flow-trends?" + range);
assert.equal(cash.expenseSeries.reduce((total, s) => total + s.budgetValues.reduce((a, b) => a + b, 0), 0), 4800000);
const trend = await api("/spending-trends?" + range + "&type=expense");
assert.ok(trend);
await api("/budgets", { effectiveDate: "2026-01-01", items: [{ categoryId: housing.id, monthlyBudgetMinor: 400000 }] }, "PUT", 409);
await save("2026-01-01", 400000, true);
const history = await api("/budget-history");
assert.equal(history.filter(s => s.effectiveDate === "2026-01-01").length, 2);
assert.equal(history.find(s => s.effectiveDate === "2026-01-01" && s.revision === 1).items.find(i => i.categoryId === housing.id).monthlyBudgetMinor, 300000);
await api("/budgets", { effectiveDate: "2026-06-01", items: [{ categoryId: salary.id, monthlyBudgetMinor: 500000 }] }, "PUT");
assert.equal((await api("/budgets?effectiveDate=2026-06-01")).find(c => c.id === housing.id).monthlyBudgetMinor, 400000);
await save("2026-09-01", 100000);
await save("2026-09-15", 300000);
assert.equal((await api("/monthly-summary?startDate=2026-09-01&endDate=2026-09-30")).totalBudgetMinor, 206667);
await api("/budgets", { effectiveDate: "2026-09-16", items: [{ categoryId: "not-owned", monthlyBudgetMinor: 100 }] }, "PUT", 409);
console.log("PASS: dated budgets, revisions, partial saves, prorating, category totals, cash-flow budgets, invalid category rejection.");
