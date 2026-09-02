/* Pure projection/reporting math. No D1 or network access occurs here, making
 * financial formulas deterministic and straightforward to unit test. */
import type { AccountProjectionInput, ProjectionAssumptions } from "./types";

export interface ProjectionPoint {
  month: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
}

export interface AccountProjectionPoint {
  month: number;
  accounts: Array<{ id: string; name: string; balanceMinor: number }>;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  fixedAssetsMinor: number;
  liquidAssetsMinor: number;
  fixedLiabilitiesMinor: number;
  liquidLiabilitiesMinor: number;
  fixedNetWorthMinor: number;
  liquidNetWorthMinor: number;
}

function monthlyRate(annualBps: number): number {
  return Math.pow(1 + annualBps / 10_000, 1 / 12) - 1;
}

export function projectAccounts(
  accounts: AccountProjectionInput[],
  assumptions: ProjectionAssumptions,
): AccountProjectionPoint[] {
  const balances = new Map(
    accounts.map((account) => [account.id, account.balanceMinor]),
  );
  const result: AccountProjectionPoint[] = [];
  const monthlyContribution =
    assumptions.monthlyIncomeMinor -
    assumptions.monthlyExpenseMinor +
    assumptions.monthlySavingsMinor;
  for (let month = 0; month <= assumptions.horizonMonths; month += 1) {
    if (month > 0) {
      for (const account of accounts) {
        let balance = balances.get(account.id) ?? 0;
        const isLiability =
          account.accountType === "liability" ||
          account.accountType === "credit_card" ||
          balance < 0;
        const payment =
          account.paymentFrequency === "monthly"
            ? account.paymentAmountMinor
            : account.paymentFrequency === "yearly" && month % 12 === 0
              ? account.paymentAmountMinor
              : 0;
        if (isLiability) {
          const magnitude = Math.max(
            0,
            Math.abs(balance) * (1 + monthlyRate(account.annualInterestBps)) -
              payment,
          );
          balance = -magnitude;
        } else {
          balance =
            balance +
            payment +
            account.annualEquityGainMinor / 12 +
            account.annualDividendMinor / 12;
        }
        balances.set(account.id, balance);
      }
    }
    const projectedAccounts = accounts.map((account) => ({
      id: account.id,
      name: account.name,
      balanceMinor: Math.round(balances.get(account.id) ?? 0),
    }));
    const assetsMinor = projectedAccounts.reduce(
      (sum, account) => sum + Math.max(0, account.balanceMinor),
      monthlyContribution * month,
    );
    const liabilitiesMinor = projectedAccounts.reduce(
      (sum, account) => sum + Math.max(0, -account.balanceMinor),
      0,
    );
    const fixedAssetsMinor = projectedAccounts.reduce(
      (sum, account) =>
        sum +
        (accounts.find((source) => source.id === account.id)?.liquidityClass ===
        "fixed"
          ? Math.max(0, account.balanceMinor)
          : 0),
      0,
    );
    const fixedLiabilitiesMinor = projectedAccounts.reduce(
      (sum, account) =>
        sum +
        (accounts.find((source) => source.id === account.id)?.liquidityClass ===
        "fixed"
          ? Math.max(0, -account.balanceMinor)
          : 0),
      0,
    );
    const liquidAssetsMinor = assetsMinor - fixedAssetsMinor;
    const liquidLiabilitiesMinor = liabilitiesMinor - fixedLiabilitiesMinor;
    const fixedNetWorthMinor = fixedAssetsMinor - fixedLiabilitiesMinor;
    const liquidNetWorthMinor = liquidAssetsMinor - liquidLiabilitiesMinor;
    result.push({
      month,
      accounts: projectedAccounts,
      assetsMinor,
      liabilitiesMinor,
      netWorthMinor: assetsMinor - liabilitiesMinor,
      fixedAssetsMinor,
      liquidAssetsMinor,
      fixedLiabilitiesMinor,
      liquidLiabilitiesMinor,
      fixedNetWorthMinor,
      liquidNetWorthMinor,
    });
  }
  return result;
}

export function projectNetWorth(
  startAssetsMinor: number,
  startLiabilitiesMinor: number,
  assumptions: ProjectionAssumptions,
): ProjectionPoint[] {
  let assets = startAssetsMinor;
  let liabilities = Math.abs(startLiabilitiesMinor);
  const liabilityRate =
    Math.pow(1 + assumptions.annualLiabilityInterestBps / 10_000, 1 / 12) - 1;
  const contribution =
    assumptions.monthlyIncomeMinor -
    assumptions.monthlyExpenseMinor +
    assumptions.monthlySavingsMinor;
  const result: ProjectionPoint[] = [
    {
      month: 0,
      assetsMinor: Math.round(assets),
      liabilitiesMinor: Math.round(liabilities),
      netWorthMinor: Math.round(assets - liabilities),
    },
  ];
  for (let month = 1; month <= assumptions.horizonMonths; month += 1) {
    assets += contribution;
    liabilities *= 1 + liabilityRate;
    result.push({
      month,
      assetsMinor: Math.round(assets),
      liabilitiesMinor: Math.round(liabilities),
      netWorthMinor: Math.round(assets - liabilities),
    });
  }
  return result;
}

export function monthlyTotals(
  rows: Array<{
    transaction_type: string;
    transaction_direction: "debit" | "credit";
    amount_minor: number;
  }>,
) {
  return rows.reduce(
    (totals, row) => {
      if (row.transaction_type === "expense")
        totals.expenseMinor +=
          row.transaction_direction === "credit"
            ? -row.amount_minor
            : row.amount_minor;
      if (row.transaction_type === "refund")
        totals.expenseMinor -= row.amount_minor;
      if (row.transaction_type === "income")
        totals.incomeMinor +=
          row.transaction_direction === "debit"
            ? -row.amount_minor
            : row.amount_minor;
      if (row.transaction_type !== "transfer") totals.transactionCount += 1;
      totals.netCashFlowMinor = totals.incomeMinor - totals.expenseMinor;
      return totals;
    },
    {
      incomeMinor: 0,
      expenseMinor: 0,
      netCashFlowMinor: 0,
      transactionCount: 0,
    },
  );
}
