export interface BudgetItem {
  categoryId: string;
  name: string;
  kind: "expense" | "income";
  masterCategoryId: string | null;
  masterName: string;
  budgetScope: "personal" | "business";
  monthlyBudgetMinor: number;
}

export interface BudgetSnapshot {
  id: string;
  effectiveDate: string;
  name: string;
  revision: number;
  createdAt: string;
  active?: boolean;
  archivedAt?: string | null;
  items: BudgetItem[];
}

export function effectiveSnapshots(history: BudgetSnapshot[]) {
  const byDate = new Map<string, BudgetSnapshot>();
  for (const snapshot of history) {
    const current = byDate.get(snapshot.effectiveDate);
    if (!current || snapshot.revision > current.revision)
      byDate.set(snapshot.effectiveDate, snapshot);
  }
  return [...byDate.values()].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
}

export function budgetAt(history: BudgetSnapshot[], date: string) {
  return effectiveSnapshots(history)
    .filter((snapshot) => snapshot.effectiveDate <= date)
    .at(-1);
}

function previousDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// Difference-of-rounded cumulative allowances ensures adjacent ranges add to
// exactly the same cent total, including partial months and leap years.
export function budgetAllowance(
  history: BudgetSnapshot[],
  startDate: string,
  endDate: string,
  predicate: (item: BudgetItem) => boolean = () => true,
) {
  const totals = new Map<string, BudgetItem & { budgetMinor: number }>();
  const snapshots = effectiveSnapshots(history);
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]!;
    const start =
      startDate > snapshot.effectiveDate ? startDate : snapshot.effectiveDate;
    const nextDate = snapshots[index + 1]?.effectiveDate;
    const end =
      nextDate && nextDate <= endDate ? previousDate(nextDate) : endDate;
    if (start > end) continue;
    const cursor = new Date(`${start}T00:00:00Z`);
    while (cursor.toISOString().slice(0, 10) <= end) {
      const month = cursor.toISOString().slice(0, 7);
      const days = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const firstOffset = cursor.getUTCDate() - 1;
      const finalDay = month === end.slice(0, 7) ? Number(end.slice(8)) : days;
      for (const item of snapshot.items.filter(predicate)) {
        const key = JSON.stringify([
          item.categoryId,
          item.masterCategoryId,
          item.budgetScope,
        ]);
        const total = totals.get(key) ?? { ...item, budgetMinor: 0 };
        total.budgetMinor +=
          Math.round((item.monthlyBudgetMinor * finalDay) / days) -
          Math.round((item.monthlyBudgetMinor * firstOffset) / days);
        totals.set(key, total);
      }
      cursor.setUTCDate(1);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return [...totals.values()];
}
