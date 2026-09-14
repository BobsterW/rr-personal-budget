export interface BudgetItem {
  categoryId: string;
  name: string;
  kind: string;
  masterCategoryId: string | null;
  masterName: string;
  budgetScope: string;
  monthlyBudgetMinor: number;
}
export interface BudgetSnapshot {
  id: string;
  effectiveDate: string;
  name: string;
  revision: number;
  createdAt: string;
  items: BudgetItem[];
}
export function effectiveSnapshots(history: BudgetSnapshot[]) {
  const dates = new Map<string, BudgetSnapshot>();
  for (const snapshot of history) {
    const previous = dates.get(snapshot.effectiveDate);
    if (!previous || snapshot.revision > previous.revision)
      dates.set(snapshot.effectiveDate, snapshot);
  }
  return [...dates.values()].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
}
export function budgetAt(history: BudgetSnapshot[], date: string) {
  return effectiveSnapshots(history)
    .filter((s) => s.effectiveDate <= date)
    .at(-1);
}
// Difference of rounded cumulative daily allowances makes adjacent date ranges
// add up exactly, including leap years and snapshots that change mid-month.
export function budgetAllowance(
  history: BudgetSnapshot[],
  start: string,
  end: string,
  predicate: (item: BudgetItem) => boolean = () => true,
) {
  const totals = new Map<string, BudgetItem & { budgetMinor: number }>();
  const snapshots = effectiveSnapshots(history);
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i]!;
    const from =
      start > snapshot.effectiveDate ? start : snapshot.effectiveDate;
    const next = snapshots[i + 1]?.effectiveDate;
    const until =
      next && next <= end
        ? new Date(Date.parse(next + "T00:00:00Z") - 86400000)
            .toISOString()
            .slice(0, 10)
        : end;
    if (from > until) continue;
    const cursor = new Date(from + "T00:00:00Z");
    while (cursor.toISOString().slice(0, 10) <= until) {
      const days = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const first = cursor.getUTCDate() - 1;
      const last =
        cursor.toISOString().slice(0, 7) === until.slice(0, 7)
          ? Number(until.slice(8))
          : days;
      for (const item of snapshot.items.filter(predicate)) {
        const key = JSON.stringify([
          item.categoryId,
          item.masterCategoryId,
          item.budgetScope,
        ]);
        const row = totals.get(key) ?? { ...item, budgetMinor: 0 };
        row.budgetMinor +=
          Math.round((item.monthlyBudgetMinor * last) / days) -
          Math.round((item.monthlyBudgetMinor * first) / days);
        totals.set(key, row);
      }
      cursor.setUTCDate(1);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return [...totals.values()];
}
