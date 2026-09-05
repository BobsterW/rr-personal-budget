export type DateOrder = "auto" | "mdy" | "dmy";
export function inferDateOrder(
  values: unknown[],
): "mdy" | "dmy" | "conflict" | null;
export function normalizeImportDate(
  value: unknown,
  selectedOrder?: DateOrder,
  inferredOrder?: "mdy" | "dmy" | "conflict" | null,
): { value: string; error: string };
