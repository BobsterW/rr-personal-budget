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
});
