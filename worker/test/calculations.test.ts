import { describe, expect, it } from "vitest";
import {
  monthlyTotals,
  projectAccounts,
  projectNetWorth,
} from "../src/calculations";

describe("monthly totals", () => {
  it("excludes transfers", () => {
    expect(
      monthlyTotals([
        { transaction_type: "income", amount_minor: 200000 },
        { transaction_type: "expense", amount_minor: 50000 },
        { transaction_type: "transfer", amount_minor: 10000 },
      ]),
    ).toEqual({
      incomeMinor: 200000,
      expenseMinor: 50000,
      netCashFlowMinor: 150000,
      transactionCount: 2,
    });
  });
});
describe("projection", () => {
  it("is deterministic and includes month zero", () => {
    const assumptions = {
      monthlyIncomeMinor: 300000,
      monthlyExpenseMinor: 250000,
      monthlySavingsMinor: 0,
      annualAssetGrowthBps: 0,
      annualLiabilityInterestBps: 0,
      horizonMonths: 2,
    };
    expect(
      projectNetWorth(1000000, 200000, assumptions).map(
        (point) => point.netWorthMinor,
      ),
    ).toEqual([800000, 850000, 900000]);
  });
});

describe("account projection", () => {
  it("applies liability payments and annual asset cash flows", () => {
    const assumptions = {
      monthlyIncomeMinor: 0,
      monthlyExpenseMinor: 0,
      monthlySavingsMinor: 0,
      annualAssetGrowthBps: 0,
      annualLiabilityInterestBps: 0,
      horizonMonths: 12,
    };
    const points = projectAccounts(
      [
        {
          id: "house",
          name: "House",
          accountType: "asset",
          liquidityClass: "fixed",
          balanceMinor: 30_000_000,
          annualGrowthBps: 0,
          paymentAmountMinor: 0,
          paymentFrequency: "none",
          annualInterestBps: 0,
          annualEquityGainMinor: 120_000,
          annualDividendMinor: 0,
          annualDepreciationBps: 0,
        },
        {
          id: "loan",
          name: "Loan",
          accountType: "liability",
          liquidityClass: "fixed",
          balanceMinor: -12_000_000,
          annualGrowthBps: 0,
          paymentAmountMinor: 100_000,
          paymentFrequency: "monthly",
          annualInterestBps: 0,
          annualEquityGainMinor: 0,
          annualDividendMinor: 0,
          annualDepreciationBps: 0,
        },
      ],
      assumptions,
    );
    expect(points[12]?.assetsMinor).toBe(30_120_000);
    expect(points[12]?.liabilitiesMinor).toBe(10_800_000);
    expect(points[12]?.fixedNetWorthMinor).toBe(19_320_000);
    expect(points[12]?.liquidNetWorthMinor).toBe(0);
  });
});
