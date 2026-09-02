/* Historical/projected net-worth engine. History is reconstructed from dated
 * snapshots plus signed transactions; projection begins at today's balances. */
import type {
  AccountType,
  LiquidityClass,
  PaymentFrequency,
  ProjectionAssumptions,
  ProjectionRule,
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
  anchorDates: string[] = [],
): string[] {
  const dates = new Set([startDate, endDate]);
  for (const date of anchorDates)
    if (date >= startDate && date <= endDate) dates.add(date);
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

function aggregate(accounts: TimelineAccount[], balances: Map<string, number>) {
  let fixed = 0,
    liquid = 0;
  for (const account of accounts) {
    const value = balances.get(account.id) ?? 0;
    if (account.liquidityClass === "fixed") fixed += value;
    else liquid += value;
  }
  return {
    fixedNetWorthMinor: Math.round(fixed),
    liquidNetWorthMinor: Math.round(liquid),
    netWorthMinor: Math.round(fixed + liquid),
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      accountType: account.accountType,
      liquidityClass: account.liquidityClass,
      balanceMinor: Math.round(balances.get(account.id) ?? 0),
    })),
  };
}

function ruleActiveDuring(rule: ProjectionRule, from: string, to: string) {
  return rule.startDate <= to && (!rule.endDate || rule.endDate > from);
}

function scheduledDate(
  startDate: string,
  frequency: "monthly" | "yearly",
  occurrence: number,
) {
  const start = utc(startDate),
    year = start.getUTCFullYear() + (frequency === "yearly" ? occurrence : 0),
    month = start.getUTCMonth() + (frequency === "monthly" ? occurrence : 0),
    normalizedYear = year + Math.floor(month / 12),
    normalizedMonth = ((month % 12) + 12) % 12,
    lastDay = new Date(
      Date.UTC(normalizedYear, normalizedMonth + 1, 0),
    ).getUTCDate(),
    day = Math.min(start.getUTCDate(), lastDay);
  return new Date(Date.UTC(normalizedYear, normalizedMonth, day))
    .toISOString()
    .slice(0, 10);
}

function ruleAmount(rule: ProjectionRule, from: string, to: string) {
  if (!ruleActiveDuring(rule, from, to)) return 0;
  if (rule.frequency === "once")
    return rule.startDate > from && rule.startDate <= to ? rule.amountMinor : 0;
  let count = 0;
  for (let occurrence = 0; occurrence < 2_400; occurrence += 1) {
    const date = scheduledDate(rule.startDate, rule.frequency, occurrence);
    if (date > to || (rule.endDate && date > rule.endDate)) break;
    if (date > from) count += 1;
  }
  return rule.amountMinor * count;
}

function applyProjectionRules(
  balances: Map<string, number>,
  rules: ProjectionRule[],
  from: string,
  to: string,
) {
  for (const rule of rules) {
    const amount = ruleAmount(rule, from, to);
    if (!amount) continue;
    if (rule.fromAccountId)
      balances.set(
        rule.fromAccountId,
        (balances.get(rule.fromAccountId) ?? 0) - amount,
      );
    if (rule.toAccountId)
      balances.set(
        rule.toAccountId,
        (balances.get(rule.toAccountId) ?? 0) + amount,
      );
  }
}

// Emit actual points through today, then compound accounts and apply planned
// purchases/contributions to each future monthly point.
export function buildNetWorthTimeline(
  accounts: TimelineAccount[],
  snapshots: TimelineSnapshot[],
  effects: TimelineEffect[],
  purchases: TimelinePurchase[],
  _assumptions: ProjectionAssumptions,
  startDate: string,
  endDate: string,
  today: string,
  projectionRules: ProjectionRule[] = [],
): TimelinePoint[] {
  const dates = timelineDates(
    startDate,
    endDate,
    today,
    snapshots.map((snapshot) => snapshot.date),
  );
  const actualSnapshots = snapshots.filter(
    (snapshot) => snapshot.date <= today,
  );
  const balances = new Map(
    accounts.map((account) => [
      account.id,
      balanceAt(today, account.id, actualSnapshots, effects),
    ]),
  );
  const result: TimelinePoint[] = dates
    .filter((date) => date <= today)
    .map((date) => {
      const historical = new Map(
        accounts.map((account) => [
          account.id,
          balanceAt(date, account.id, actualSnapshots, effects),
        ]),
      );
      return {
        date,
        phase: "actual" as const,
        ...aggregate(accounts, historical),
      };
    });
  let previous = today;
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
      // Cash-funded payments must be represented by a projection transfer so
      // both the paying account and receiving asset/liability change together.
      value += liability
        ? 0
        : (account.annualEquityGainMinor + account.annualDividendMinor) *
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
    // Recurring income, expenses, transfers, and debt payments now affect the
    // selected real accounts instead of an invented projected-cash-flow layer.
    applyProjectionRules(balances, projectionRules, previous, date);
    // A dated account balance is authoritative. Projection variables run up to
    // the anchor, the balance is reset, and subsequent variables continue from
    // the newly supplied value.
    for (const snapshot of snapshots.filter((item) => item.date === date))
      balances.set(snapshot.accountId, snapshot.balanceMinor);
    result.push({
      date,
      phase: "projected",
      ...aggregate(accounts, balances),
    });
    previous = date;
  }
  return result;
}
