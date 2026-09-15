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
  it("splits a linked mortgage payment into interest and principal", () => {
    const mortgageAccounts: TimelineAccount[] = [
      { ...accounts[0]!, id: "checking", name: "Checking" },
      {
        ...accounts[0]!,
        id: "mortgage",
        name: "Mortgage",
        accountType: "liability",
      },
    ];
    const points = buildNetWorthTimeline(
      mortgageAccounts,
      [
        { accountId: "checking", date: "2026-09-01", balanceMinor: 1_000_000 },
        {
          accountId: "mortgage",
          date: "2026-09-01",
          balanceMinor: -50_000_000,
        },
      ],
      [],
      assumptions,
      "2026-09-01",
      "2026-10-01",
      "2026-09-01",
      [
        {
          id: "mortgage-rule",
          description: "Mortgage payment",
          ruleType: "debt_payment",
          amountMinor: 263_000,
          frequency: "monthly",
          startDate: "2026-10-01",
          endDate: null,
          fromAccountId: "checking",
          toAccountId: null,
          linkedAccountId: "mortgage",
          annualRateBps: 400,
        },
      ],
    );
    const end = points.at(-1)!;
    expect(end.accounts.find((a) => a.id === "checking")?.balanceMinor).toBe(
      737_000,
    );
    expect(end.accounts.find((a) => a.id === "mortgage")?.balanceMinor).toBe(
      -49_900_687,
    );
    expect(end.netWorthMinor).toBe(-49_163_687);
  });

  it("deposits linked savings yield into its selected destination", () => {
    const points = buildNetWorthTimeline(
      [
        { ...accounts[0]!, id: "savings" },
        { ...accounts[0]!, id: "cash" },
      ],
      [{ accountId: "savings", date: "2026-09-01", balanceMinor: 2_000_000 }],
      [],
      assumptions,
      "2026-09-01",
      "2026-10-01",
      "2026-09-01",
      [
        {
          id: "interest",
          description: "Savings interest",
          ruleType: "yield",
          amountMinor: 0,
          frequency: "monthly",
          startDate: "2026-10-01",
          endDate: null,
          fromAccountId: null,
          toAccountId: "cash",
          linkedAccountId: "savings",
          annualRateBps: 400,
          treatment: "deposit",
        },
      ],
    );
    expect(
      points.at(-1)!.accounts.find((a) => a.id === "cash")?.balanceMinor,
    ).toBe(6_547);
  });
  it("changes resolution without changing the final financial result", () => {
    const resolutions = [
      "yearly",
      "quarterly",
      "monthly",
      "weekly",
      "daily",
    ] as const;
    const series = resolutions.map((resolution) =>
      buildNetWorthTimeline(
        [{ ...accounts[0]!, annualGrowthBps: 400 }],
        [{ accountId: "cash", date: "2026-01-01", balanceMinor: 5_000_000 }],
        [],
        assumptions,
        "2026-01-01",
        "2027-12-31",
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
        ],
        resolution,
      ),
    );
    for (const points of series)
      expect(points.at(-1)).toEqual(series[4]!.at(-1));
    expect(series[0]!.length).toBeLessThan(series[2]!.length);
    expect(series[2]!.length).toBeLessThan(series[4]!.length);
  });
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

  it("marks today and deducts a one-time projection rule", () => {
    const points = buildNetWorthTimeline(
      accounts,
      [{ accountId: "cash", date: "2026-08-20", balanceMinor: 100_000 }],
      [],
      assumptions,
      "2026-08-01",
      "2026-10-01",
      "2026-08-20",
      [
        {
          id: "purchase",
          description: "One-time purchase",
          ruleType: "expense",
          amountMinor: 25_000,
          frequency: "once",
          startDate: "2026-09-15",
          endDate: null,
          fromAccountId: "cash",
          toAccountId: null,
        },
      ],
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

  it("uses future balances as authoritative anchors and continues visible rules", () => {
    const points = buildNetWorthTimeline(
      accounts,
      [{ accountId: "cash", date: "2027-12-15", balanceMinor: 50_000_000 }],
      [],
      assumptions,
      "2026-09-01",
      "2028-12-15",
      "2026-09-01",
      [
        {
          id: "linked-growth",
          description: "Visible monthly account contribution",
          ruleType: "income",
          amountMinor: 10_000,
          frequency: "monthly",
          startDate: "2027-12-15",
          endDate: null,
          fromAccountId: null,
          toAccountId: "cash",
        },
      ],
    );
    const at = (date: string) =>
      points.find((point) => point.date === date)?.accounts[0]?.balanceMinor;
    expect(at("2026-09-01")).toBe(0);
    expect(at("2027-12-15")).toBe(50_000_000);
    expect(at("2028-12-15")).toBe(50_120_000);
  });

  it("resets the projection at every later balance entry", () => {
    const points = buildNetWorthTimeline(
      accounts,
      [
        { accountId: "cash", date: "2026-09-01", balanceMinor: 100_000 },
        { accountId: "cash", date: "2026-10-15", balanceMinor: 250_000 },
        { accountId: "cash", date: "2026-11-15", balanceMinor: 400_000 },
      ],
      [],
      assumptions,
      "2026-09-01",
      "2026-12-01",
      "2026-09-01",
      [
        {
          id: "income",
          description: "Income",
          ruleType: "income",
          amountMinor: 10_000,
          frequency: "monthly",
          startDate: "2026-09-15",
          endDate: null,
          fromAccountId: null,
          toAccountId: "cash",
        },
      ],
    );
    const at = (date: string) =>
      points.find((point) => point.date === date)?.accounts[0]?.balanceMinor;
    expect(at("2026-10-15")).toBe(250_000);
    expect(at("2026-11-15")).toBe(400_000);
    expect(at("2026-12-01")).toBe(400_000);
  });
});
