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
  const value = response.status === 204 ? {} : await response.json();
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
const septemberRevision = (await api("/budget-history")).find(
  (row) => row.effectiveDate === "2026-09-15",
);
await api(`/budget-history/${septemberRevision.id}`, null, "DELETE", 204);
assert.equal(
  (await api("/monthly-summary?startDate=2026-09-01&endDate=2026-09-30"))
    .totalBudgetMinor,
  100_000,
);
assert.ok(
  (await api("/archived-items")).budgetSnapshots.some(
    (row) => row.id === septemberRevision.id,
  ),
);
await api(`/archived-items/budget/${septemberRevision.id}`, {}, "POST");
assert.equal(
  (await api("/monthly-summary?startDate=2026-09-01&endDate=2026-09-30"))
    .totalBudgetMinor,
  206_667,
);

const accountBody = (name, accountType, accountModel, liquidityClass) => ({
  name,
  accountType,
  accountModel,
  liquidityClass,
  budgetScope: "personal",
  annualGrowthBps: 0,
  paymentAmountMinor: 0,
  paymentFrequency: "none",
  annualInterestBps: 0,
  annualEquityGainMinor: 0,
  annualDividendMinor: 0,
  annualDepreciationBps: 0,
  projectionNotes: "",
});
const checking = await api(
  "/accounts",
  accountBody("Rule Checking", "chequing", "cash", "liquid"),
  "POST",
  201,
);
const mortgage = await api(
  "/accounts",
  accountBody("Rule Mortgage", "liability", "mortgage", "fixed"),
  "POST",
  201,
);
const mortgageRule = await api(
  "/projection-rules",
  {
    description: "Linked mortgage payment",
    ruleType: "debt_payment",
    amountMinor: 263_000,
    frequency: "monthly",
    startDate: "2026-10-01",
    endDate: null,
    fromAccountId: checking.id,
    toAccountId: null,
    linkedAccountId: mortgage.id,
    categoryId: housing.id,
    annualRateBps: 400,
    compoundingInterval: "monthly",
    treatment: "deposit",
    amortizationMonths: 300,
    termMonths: 60,
    renewalDate: "2031-10-01",
    renewalRateBps: 500,
  },
  "POST",
  201,
);
assert.equal(mortgageRule.linkedAccountId, mortgage.id);
assert.equal(mortgageRule.annualRateBps, 400);
await api(
  "/balance-snapshots",
  {
    accountId: checking.id,
    snapshotDate: "2026-09-14",
    balanceMinor: 1_000_000,
    note: "QA",
  },
  "POST",
  201,
);
await api(
  "/balance-snapshots",
  {
    accountId: mortgage.id,
    snapshotDate: "2026-09-14",
    balanceMinor: -50_000_000,
    note: "QA",
  },
  "POST",
  201,
);
const timeline = await api(
  "/net-worth-timeline?startDate=2026-09-14&endDate=2026-10-02&resolution=daily",
);
const october = timeline.points.find((point) => point.date === "2026-10-01");
assert.equal(
  october.accounts.find((account) => account.id === checking.id).balanceMinor,
  737_000,
);
assert.ok(
  october.accounts.find((account) => account.id === mortgage.id).balanceMinor >
    -50_000_000,
);
console.log(
  "PASS: snapshots, archive/restore, partial saves, cross-period totals, charts, proration, and linked account rules.",
);
