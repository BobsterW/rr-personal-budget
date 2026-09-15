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

function ruleOccursOn(rule: ProjectionRule, date: string) {
  if (date < rule.startDate || (rule.endDate && date > rule.endDate))
    return false;
  if (rule.frequency === "once") return date === rule.startDate;
  const elapsedDays = daysBetween(rule.startDate, date);
  if (rule.frequency === "weekly") return elapsedDays % 7 === 0;
  if (rule.frequency === "biweekly") return elapsedDays % 14 === 0;
  const start = utc(rule.startDate),
    target = utc(date);
  if (rule.frequency === "yearly") {
    const years = target.getUTCFullYear() - start.getUTCFullYear();
    return (
      years >= 0 && scheduledDate(rule.startDate, "yearly", years) === date
    );
  }
  const months =
    (target.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    target.getUTCMonth() -
    start.getUTCMonth();
  return (
    months >= 0 && scheduledDate(rule.startDate, "monthly", months) === date
  );
}

const periodsPerYear = (frequency: ProjectionRule["frequency"]) =>
  frequency === "weekly"
    ? 52
    : frequency === "biweekly"
      ? 26
      : frequency === "monthly"
        ? 12
        : 1;
const periodicRate = (annualBps: number, periods: number) =>
  Math.pow(1 + annualBps / 10_000, 1 / Math.max(1, periods)) - 1;

function applyProjectionRules(
  balances: Map<string, number>,
  rules: ProjectionRule[],
  from: string,
  to: string,
) {
  for (const rule of rules) {
    if (!ruleActiveDuring(rule, from, to) || !ruleOccursOn(rule, to)) continue;
    const rateBps =
      rule.renewalDate && rule.renewalRateBps != null && to >= rule.renewalDate
        ? rule.renewalRateBps
        : (rule.annualRateBps ?? 0);
    const linkedBalance = rule.linkedAccountId
      ? (balances.get(rule.linkedAccountId) ?? 0)
      : 0;
    const rate = periodicRate(rateBps, periodsPerYear(rule.frequency));
    if (rule.ruleType === "asset_growth") {
      if (rule.linkedAccountId)
        balances.set(rule.linkedAccountId, linkedBalance * (1 + rate));
      continue;
    }
    if (rule.ruleType === "yield") {
      const generated = Math.round(Math.abs(linkedBalance) * rate);
      const destination =
        rule.treatment === "reinvest" ? rule.linkedAccountId : rule.toAccountId;
      if (destination)
        balances.set(destination, (balances.get(destination) ?? 0) + generated);
      continue;
    }
    if (rule.ruleType === "debt_interest") {
      if (rule.linkedAccountId)
        balances.set(
          rule.linkedAccountId,
          linkedBalance - Math.round(Math.abs(linkedBalance) * rate),
        );
      continue;
    }
    if (rule.ruleType === "debt_payment") {
      const payment = rule.amountMinor;
      const interest = Math.round(Math.abs(linkedBalance) * rate);
      const principal = Math.max(
        0,
        Math.min(Math.abs(linkedBalance), payment - interest),
      );
      if (rule.fromAccountId)
        balances.set(
          rule.fromAccountId,
          (balances.get(rule.fromAccountId) ?? 0) - payment,
        );
      if (rule.linkedAccountId)
        balances.set(rule.linkedAccountId, linkedBalance + principal);
      continue;
    }
    const amount = rule.amountMinor;
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

// Emit actual points through today, then compound accounts and apply explicit
// projection rules to each future monthly point.
export function buildNetWorthTimeline(
  accounts: TimelineAccount[],
  snapshots: TimelineSnapshot[],
  effects: TimelineEffect[],
  _assumptions: ProjectionAssumptions,
  startDate: string,
  endDate: string,
  today: string,
  projectionRules: ProjectionRule[] = [],
  resolution:
    | "yearly"
    | "quarterly"
    | "monthly"
    | "weekly"
    | "daily" = "monthly",
): TimelinePoint[] {
  const dates = timelineDates(
    startDate,
    endDate,
    today,
    snapshots.map((snapshot) => snapshot.date),
  );
  // Daily internal steps keep payment timing and interest identical at every
  // display resolution. Coarser resolutions only reduce returned points.
  const dateSet = new Set(dates);
  const daily = utc(startDate < today ? startDate : today);
  const end = utc(endDate);
  while (daily <= end) {
    const date = daily.toISOString().slice(0, 10);
    if (!dateSet.has(date)) dates.push(date);
    daily.setUTCDate(daily.getUTCDate() + 1);
  }
  dates.sort();
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
    // Every future account change now comes from a visible projection rule.
    // Legacy account-assumption columns remain readable for migration safety
    // but are deliberately not applied, preventing double counting.
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
  return result.filter((point) => {
    if (point.date < startDate) return false;
    if (
      [startDate, endDate, today].includes(point.date) ||
      snapshots.some((s) => s.date === point.date)
    )
      return true;
    const date = utc(point.date);
    if (resolution === "daily") return true;
    if (resolution === "weekly") return date.getUTCDay() === 1;
    if (date.getUTCDate() !== 1) return false;
    if (resolution === "yearly") return date.getUTCMonth() === 0;
    if (resolution === "quarterly") return date.getUTCMonth() % 3 === 0;
    return true;
  });
}
