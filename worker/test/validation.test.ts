import { describe, expect, it } from "vitest";
import { validateTransaction } from "../src/validation";

describe("transaction validation", () => {
  it("accepts a valid transaction", () => {
    expect(
      validateTransaction({
        transactionDate: "2026-06-30",
        categoryId: "c",
        accountId: "a",
        vendorName: "Vendor",
        amountMinor: 123,
        transactionType: "expense",
        transactionDirection: "debit",
      }).issues,
    ).toHaveLength(0);
  });
  it("rejects impossible dates and fractional cents", () => {
    const result = validateTransaction({
      transactionDate: "2026-02-30",
      categoryId: "c",
      accountId: "a",
      vendorName: "Vendor",
      amountMinor: 1.2,
      transactionType: "expense",
      transactionDirection: "debit",
    });
    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["transactionDate", "amountMinor"]),
    );
  });
  it("accepts a credit refund while keeping the expense type", () => {
    const result = validateTransaction({
      transactionDate: "2026-07-01",
      categoryId: "clothing",
      accountId: "card",
      vendorName: "Boot store refund",
      amountMinor: 10_000,
      transactionType: "expense",
      transactionDirection: "credit",
    });
    expect(result.issues).toHaveLength(0);
    expect(result.data?.transactionDirection).toBe("credit");
  });

  it("accepts a first-class refund type", () => {
    const result = validateTransaction({
      transactionDate: "2026-09-02",
      categoryId: "shopping",
      accountId: "card",
      vendorName: "Returned purchase",
      amountMinor: 2_500,
      transactionType: "refund",
      transactionDirection: "credit",
    });
    expect(result.issues).toEqual([]);
    expect(result.data?.transactionType).toBe("refund");
  });
});
