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
    });
    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["transactionDate", "amountMinor"]),
    );
  });
});
