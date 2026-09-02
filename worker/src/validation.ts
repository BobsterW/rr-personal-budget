/* Validate untrusted transaction JSON without writing data. Success returns a
 * normalized TransactionInput; failure returns field-specific issues. */
import type {
  TransactionInput,
  TransactionDirection,
  TransactionType,
  ValidationIssue,
} from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set<TransactionType>([
  "expense",
  "refund",
  "income",
  "transfer",
  "adjustment",
]);
const DIRECTIONS = new Set<TransactionDirection>(["debit", "credit"]);

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

export function validateTransaction(value: unknown): {
  data?: TransactionInput;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      issues: [{ field: "body", message: "A JSON object is required." }],
    };
  const body = value as Record<string, unknown>;
  if (!isIsoDate(body.transactionDate))
    issues.push({
      field: "transactionDate",
      message: "Use a real date in YYYY-MM-DD format.",
    });
  for (const field of ["categoryId", "accountId"] as const)
    if (typeof body[field] !== "string" || !body[field].trim())
      issues.push({ field, message: "This field is required." });
  if (
    typeof body.vendorName !== "string" ||
    body.vendorName.trim().length < 1 ||
    body.vendorName.trim().length > 120
  )
    issues.push({
      field: "vendorName",
      message: "Vendor must be 1–120 characters.",
    });
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" || body.description.length > 500)
  )
    issues.push({
      field: "description",
      message: "Description must be at most 500 characters.",
    });
  if (!Number.isSafeInteger(body.amountMinor) || Number(body.amountMinor) <= 0)
    issues.push({
      field: "amountMinor",
      message: "Amount must be a positive integer number of cents.",
    });
  if (
    typeof body.transactionType !== "string" ||
    !TYPES.has(body.transactionType as TransactionType)
  )
    issues.push({
      field: "transactionType",
      message: "Use expense, refund, income, transfer, or adjustment.",
    });
  if (
    typeof body.transactionDirection !== "string" ||
    !DIRECTIONS.has(body.transactionDirection as TransactionDirection)
  )
    issues.push({
      field: "transactionDirection",
      message: "Use debit for money out or credit for money in.",
    });
  if (
    body.currency !== undefined &&
    (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency))
  )
    issues.push({
      field: "currency",
      message: "Currency must be a three-letter uppercase code.",
    });
  if (
    body.balanceEffectMinor !== undefined &&
    body.balanceEffectMinor !== null &&
    !Number.isSafeInteger(body.balanceEffectMinor)
  )
    issues.push({
      field: "balanceEffectMinor",
      message: "Balance effect must be integer cents or null.",
    });
  if (issues.length) return { issues };
  return {
    data: {
      transactionDate: body.transactionDate as string,
      categoryId: String(body.categoryId),
      accountId: String(body.accountId),
      vendorName: String(body.vendorName).trim(),
      description: String(body.description ?? ""),
      amountMinor: Number(body.amountMinor),
      transactionType: body.transactionType as TransactionType,
      transactionDirection: body.transactionDirection as TransactionDirection,
      currency: String(body.currency ?? "CAD"),
      importFingerprint:
        typeof body.importFingerprint === "string"
          ? body.importFingerprint
          : undefined,
      balanceEffectMinor:
        body.balanceEffectMinor === null
          ? null
          : Number.isSafeInteger(body.balanceEffectMinor)
            ? Number(body.balanceEffectMinor)
            : undefined,
    },
    issues,
  };
}

export function parseMonth(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  return isIsoDate(`${value}-01`) ? value : null;
}
