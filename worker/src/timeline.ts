/* Historical/projected net-worth engine. History is reconstructed from dated
 * snapshots plus signed transactions; projection begins at today's balances. */
import type {
  AccountType,
  LiquidityClass,
  PaymentFrequency,
  ProjectionAssumptions,
} from "./types";

export interface TimelineAccount {
  id: string;
  name: string;
  accountType: AccountType;
  liquidityClass: LiquidityClass;
  annualGrowthBps: number;
  paymentAmountMinor: number;
  paymentFrequency: PaymentFrequency;
  annualInterestBps: number;
  annualEquityGainMinor: number;
  annualDividendMinor: number;
  annualDepreciationBps: number;
}
export interface TimelineSnapshot {
  accountId: string;
  date: string;
  balanceMinor: number;
}
export interface TimelineEffect {
  accountId: string;
  date: string;
  effectMinor: number;
}
export interface TimelinePurchase {
  accountId: string;
  date: string;
  amountMinor: number;
}
export interface TimelinePoint {
  date: string;
  phase: "actual" | "projected";
  fixedNetWorthMinor: number;
  liquidNetWorthMinor: number;
  netWorthMinor: number;
  accounts: Array<{
    id: string;
    name: string;
    accountType: AccountType;
    liquidityClass: LiquidityClass;
    balanceMinor: number;
  }>;
}

const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const daysBetween = (from: string, to: string) =>
  Math.max(0, (utc(to).getTime() - utc(from).getTime()) / 86_400_000);

export function timelineDates(
  startDate: string,
  endDate: string,
  today: string,
): string[] {
  const dates = new Set([startDate, endDate]);
  if (today >= startDate && today <= endDate) dates.add(today);
  const cursor = utc(`${startDate.slice(0, 7)}-01`);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  while (cursor <= utc(endDate)) {
    dates.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...dates].sort();
}

// Start at the closest snapshot. Add effects while moving forward or reverse
// them while moving backward; use accumulated effects if no snapshot exists.
export function balanceAt(
  date: string,
  accountId: string,
  snapshots: TimelineSnapshot[],
  effects: TimelineEffect[],
): number {
  const accountSnapshots = snapshots
    .filter((item) => item.accountId === accountId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const before = accountSnapshots.filter((item) => item.date <= date).at(-1);
  if (before)
    return (
      before.balanceMinor +
      effects
        .filter(
          (item) =>
            item.accountId === accountId &&
            item.date > before.date &&
            item.date <= date,
        )
        .reduce((sum, item) => sum + item.effectMinor, 0)
    );
  const after = accountSnapshots.find((item) => item.date > date);
  if (after)
    return (
      after.balanceMinor -
      effects
        .filter(
          (item) =>
            item.accountId === accountId &&
            item.date > date &&
            item.date <= after.date,
        )
        .reduce((sum, item) => sum + item.effectMinor, 0)
    );
  return effects
    .filter((item) => item.accountId === accountId && item.date <= date)
    .reduce((sum, item) => sum + item.effectMinor, 0);
}

function aggregate(
  accounts: TimelineAccount[],
  balances: Map<string, number>,
  extraLiquid = 0,
) {
  let fixed = 0,
    liquid = extraLiquid;
  for (const account of accounts) {
    const value = balances.get(account.id) ?? 0;
    if (account.liquidityClass === "fixed") fixed += value;
    else liquid += value;
  }
  return {
    fixedNetWorthMinor: Math.round(fixed),
    liquidNetWorthMinor: Math.round(liquid),
    netWorthMinor: Math.round(fixed + liquid),
    accounts: [
      ...accounts.map((account) => ({
        id: account.id,
        name: account.name,
        accountType: account.accountType,
        liquidityClass: account.liquidityClass,
        balanceMinor: Math.round(balances.get(account.id) ?? 0),
      })),
      ...(extraLiquid
        ? [
            {
              id: "projected-cash-flow",
              name: "Projected cash flow",
              accountType: "cash" as const,
              liquidityClass: "liquid" as const,
              balanceMinor: Math.round(extraLiquid),
            },
          ]
        : []),
    ],
  };
}

// Emit actual points through today, then compound accounts and apply planned
// purchases/contributions to each future monthly point.
export function buildNetWorthTimeline(
  accounts: TimelineAccount[],
  snapshots: TimelineSnapshot[],
  effects: TimelineEffect[],
  purchases: TimelinePurchase[],
  assumptions: ProjectionAssumptions,
  startDate: string,
  endDate: string,
  today: string,
): TimelinePoint[] {
  const dates = timelineDates(startDate, endDate, today);
  const balances = new Map(
    accounts.map((account) => [
      account.id,
      balanceAt(today, account.id, snapshots, effects),
    ]),
  );
  const result: TimelinePoint[] = dates
    .filter((date) => date <= today)
    .map((date) => {
      const historical = new Map(
        accounts.map((account) => [
          account.id,
          balanceAt(date, account.id, snapshots, effects),
        ]),
      );
      return {
        date,
        phase: "actual" as const,
        ...aggregate(accounts, historical),
      };
    });
  let previous = today,
    extraLiquid = 0;
  const monthlyContribution =
    assumptions.monthlyIncomeMinor -
    assumptions.monthlyExpenseMinor +
    assumptions.monthlySavingsMinor;
  for (const date of dates.filter((item) => item > today)) {
    const months = daysBetween(previous, date) / 30.4375;
    for (const account of accounts) {
      let value = balances.get(account.id) ?? 0;
      const liability =
        account.accountType === "liability" ||
        account.accountType === "credit_card" ||
        value < 0;
      // V7.2 intentionally removes asset growth and depreciation assumptions.
      // Assets change through explicit payments, equity, dividends and purchases;
      // liabilities may still accrue their configured interest.
      const annualRate = liability ? account.annualInterestBps : 0;
      value *= Math.pow(1 + annualRate / 10_000, months / 12);
      const regularPayments =
        account.paymentFrequency === "monthly"
          ? account.paymentAmountMinor * months
          : account.paymentFrequency === "yearly"
            ? account.paymentAmountMinor * (months / 12)
            : 0;
      value += liability
        ? regularPayments
        : regularPayments +
          (account.annualEquityGainMinor + account.annualDividendMinor) *
            (months / 12);
      balances.set(account.id, value);
    }
    for (const purchase of purchases.filter(
      (item) => item.date > previous && item.date <= date,
    ))
      balances.set(
        purchase.accountId,
        (balances.get(purchase.accountId) ?? 0) - purchase.amountMinor,
      );
    extraLiquid += monthlyContribution * months;
    result.push({
      date,
      phase: "projected",
      ...aggregate(accounts, balances, extraLiquid),
    });
    previous = date;
  }
  return result;
}
