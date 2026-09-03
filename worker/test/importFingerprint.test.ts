import { describe, expect, it } from "vitest";
import { importFingerprintSource } from "../src/importFingerprint";

const base = {
  accountId: "card",
  transactionDate: "2026-08-10",
  postedDate: "2026-08-11",
  sourceRow: '["2026-08-10","Boot Shop","100.00"]',
  vendorName: "Boot Shop",
  amountMinor: 10_000,
  transactionType: "expense",
  transactionDirection: "debit",
  occurrenceNumber: 1,
};

describe("CSV import fingerprints", () => {
  it("prefers a bank transaction ID when one is available", () => {
    const first = importFingerprintSource({
      ...base,
      sourceTransactionId: "bank-123",
    });
    const reformatted = importFingerprintSource({
      ...base,
      sourceTransactionId: "bank-123",
      sourceRow: "a differently formatted export row",
      vendorName: "BOOT SHOP LTD",
    });
    expect(reformatted).toBe(first);
  });

  it("keeps repeated legitimate rows distinct by occurrence", () => {
    expect(importFingerprintSource(base)).not.toBe(
      importFingerprintSource({ ...base, occurrenceNumber: 2 }),
    );
  });

  it("does not collide when source rows or posted dates differ", () => {
    expect(importFingerprintSource(base)).not.toBe(
      importFingerprintSource({
        ...base,
        postedDate: "2026-08-12",
        sourceRow: '["2026-08-10","Boot Shop","100.00","posted"]',
      }),
    );
  });
});
