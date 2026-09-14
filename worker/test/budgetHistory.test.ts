import { describe, expect, it } from "vitest";
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
  id: `${date}-${revision}`,
  effectiveDate: date,
  name: "Test",
  revision,
  createdAt: `${date}T00:00:00Z`,
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
  it("uses each snapshot only for its effective period", () => {
    const history = [
      snapshot("2025-01-01", 100_000),
      snapshot("2026-01-01", 300_000),
    ];
    expect(total(history, "2025-01-01", "2026-12-31")).toBe(4_800_000);
  });
  it("prorates a mid-month change by calendar day", () => {
    expect(
      total(
        [snapshot("2026-09-01", 100_000), snapshot("2026-09-15", 300_000)],
        "2026-09-01",
        "2026-09-30",
      ),
    ).toBe(206_667);
  });
  it("uses the latest same-date revision without erasing history", () => {
    const history = [
      snapshot("2026-01-01", 100_000),
      snapshot("2026-01-01", 250_000, 2),
    ];
    expect(budgetAt(history, "2026-06-01")?.revision).toBe(2);
    expect(history).toHaveLength(2);
  });
  it("handles leap-day ranges without penny drift", () => {
    const history = [snapshot("2024-02-01", 29_000)];
    expect(total(history, "2024-02-01", "2024-02-29")).toBe(29_000);
    expect(
      total(history, "2024-02-01", "2024-02-14") +
        total(history, "2024-02-15", "2024-02-29"),
    ).toBe(29_000);
  });
});
