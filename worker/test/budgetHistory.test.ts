import { describe, it, expect } from "vitest";
import {
  budgetAllowance,
  budgetAt,
  type BudgetSnapshot,
} from "../src/budgetHistory";
const snapshot = (
  date: string,
  amount: number,
  revision = 1,
): BudgetSnapshot => ({
  id: date + revision,
  effectiveDate: date,
  name: "Housing",
  revision,
  createdAt: "",
  items: [
    {
      categoryId: "housing",
      name: "Housing",
      kind: "expense",
      masterCategoryId: "home",
      masterName: "Home",
      budgetScope: "personal",
      monthlyBudgetMinor: amount,
    },
  ],
});
const total = (history: BudgetSnapshot[], start: string, end: string) =>
  budgetAllowance(history, start, end).reduce(
    (sum, row) => sum + row.budgetMinor,
    0,
  );
describe("effective budget history", () => {
  it("uses both budgets across two years and a six-month crossing range", () => {
    const history = [
      snapshot("2025-01-01", 100000),
      snapshot("2026-01-01", 300000),
    ];
    expect(total(history, "2025-01-01", "2026-12-31")).toBe(4800000);
    expect(total(history, "2025-10-01", "2026-03-31")).toBe(1200000);
  });
  it("prorates a mid-month change without rounding drift", () => {
    const history = [
      snapshot("2026-09-01", 100000),
      snapshot("2026-09-15", 300000),
    ];
    expect(total(history, "2026-09-01", "2026-09-30")).toBe(206667);
    expect(
      total(history, "2026-09-01", "2026-09-14") +
        total(history, "2026-09-15", "2026-09-30"),
    ).toBe(206667);
  });
  it("handles leap-day partial ranges and revisions", () => {
    const history = [
      snapshot("2024-01-01", 10000),
      snapshot("2024-01-01", 29000, 2),
    ];
    expect(total(history, "2024-02-29", "2024-02-29")).toBe(1000);
    expect(total(history, "2024-02-01", "2024-02-29")).toBe(29000);
    expect(budgetAt(history, "2023-12-31")).toBeUndefined();
    expect(budgetAt(history, "2024-03-01")?.revision).toBe(2);
  });
  it("preserves snapshot labels and scope for filtering", () => {
    const history = [snapshot("2026-01-01", 10000)];
    const next = snapshot("2026-02-01", 20000);
    next.items[0]!.budgetScope = "business";
    history.push(next);
    expect(
      budgetAllowance(
        history,
        "2026-01-01",
        "2026-02-28",
        (item) => item.budgetScope === "personal",
      )[0]?.budgetMinor,
    ).toBe(10000);
  });
});
