import { describe, expect, it } from "vitest";
import {
  balanceAt,
  buildNetWorthTimeline,
  type TimelineAccount,
} from "../src/timeline";

const assumptions = {
  monthlyIncomeMinor: 0,
  monthlyExpenseMinor: 0,
  monthlySavingsMinor: 0,
  annualAssetGrowthBps: 0,
  annualLiabilityInterestBps: 0,
  horizonMonths: 60,
};

const accounts: TimelineAccount[] = [
  {
    id: "cash",
    name: "Cash",
    accountType: "chequing",
    liquidityClass: "liquid",
    annualGrowthBps: 0,
    paymentAmountMinor: 0,
    paymentFrequency: "none",
    annualInterestBps: 0,
    annualEquityGainMinor: 0,
    annualDividendMinor: 0,
    annualDepreciationBps: 0,
  },
];

describe("net-worth timeline", () => {
  it("reconstructs history on both sides of a balance snapshot", () => {
    const snapshots = [
      { accountId: "cash", date: "2026-06-30", balanceMinor: 100_000 },
    ];
    const effects = [
      { accountId: "cash", date: "2026-06-15", effectMinor: -10_000 },
      { accountId: "cash", date: "2026-07-10", effectMinor: 20_000 },
    ];
    expect(balanceAt("2026-06-01", "cash", snapshots, effects)).toBe(110_000);
    expect(balanceAt("2026-07-31", "cash", snapshots, effects)).toBe(120_000);
  });

  it("marks today and deducts a planned purchase from future liquid net worth", () => {
    const points = buildNetWorthTimeline(
      accounts,
      [{ accountId: "cash", date: "2026-08-20", balanceMinor: 100_000 }],
      [],
      [{ accountId: "cash", date: "2026-09-15", amountMinor: 25_000 }],
      assumptions,
      "2026-08-01",
      "2026-10-01",
      "2026-08-20",
    );
    expect(points.find((point) => point.date === "2026-08-20")).toMatchObject({
      phase: "actual",
      netWorthMinor: 100_000,
    });
    expect(points.at(-1)).toMatchObject({
      phase: "projected",
      liquidNetWorthMinor: 75_000,
      netWorthMinor: 75_000,
    });
    expect(points.at(-1)?.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cash", balanceMinor: 75_000 }),
      ]),
    );
  });

  it("routes projected cash through real accounts without inventing a cash-flow account", () => {
    const twoAccounts: TimelineAccount[] = [
      accounts[0]!,
      { ...accounts[0]!, id: "savings", name: "Savings" },
    ];
    const points = buildNetWorthTimeline(
      twoAccounts,
      [
        { accountId: "cash", date: "2026-08-20", balanceMinor: 100_000 },
        { accountId: "savings", date: "2026-08-20", balanceMinor: 50_000 },
      ],
      [],
      [],
      assumptions,
      "2026-08-20",
      "2026-10-01",
      "2026-08-20",
      [
        {
          id: "salary",
          description: "Salary",
          ruleType: "income",
          amountMinor: 20_000,
          frequency: "once",
          startDate: "2026-09-01",
          endDate: null,
          fromAccountId: null,
          toAccountId: "cash",
        },
        {
          id: "save",
          description: "Move to savings",
          ruleType: "transfer",
          amountMinor: 10_000,
          frequency: "once",
          startDate: "2026-09-15",
          endDate: null,
          fromAccountId: "cash",
          toAccountId: "savings",
        },
      ],
    );
    const last = points.at(-1)!;
    expect(last.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cash", balanceMinor: 110_000 }),
        expect.objectContaining({ id: "savings", balanceMinor: 60_000 }),
      ]),
    );
    expect(
      last.accounts.some((account) => account.id === "projected-cash-flow"),
    ).toBe(false);
    expect(last.netWorthMinor).toBe(170_000);
  });

  it("posts yearly and once-only rules as discrete scheduled events", () => {
    const points = buildNetWorthTimeline(
      accounts,
      [{ accountId: "cash", date: "2026-01-01", balanceMinor: 5_000_000 }],
      [],
      [],
      assumptions,
      "2026-01-01",
      "2028-01-01",
      "2026-01-01",
      [
        {
          id: "insurance",
          description: "Insurance",
          ruleType: "expense",
          amountMinor: 800_000,
          frequency: "yearly",
          startDate: "2026-06-15",
          endDate: null,
          fromAccountId: "cash",
          toAccountId: null,
        },
        {
          id: "purchase",
          description: "One-time purchase",
          ruleType: "expense",
          amountMinor: 200_000,
          frequency: "once",
          startDate: "2027-03-10",
          endDate: null,
          fromAccountId: "cash",
          toAccountId: null,
        },
      ],
    );
    const value = (date: string) =>
      points.find((point) => point.date === date)?.accounts[0]?.balanceMinor;
    expect(value("2026-06-01")).toBe(5_000_000);
    expect(value("2026-07-01")).toBe(4_200_000);
    expect(value("2027-03-01")).toBe(4_200_000);
    expect(value("2027-04-01")).toBe(4_000_000);
    expect(value("2027-07-01")).toBe(3_200_000);
  });
});
