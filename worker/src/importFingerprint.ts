export interface ImportFingerprintSource {
  accountId: string;
  transactionDate: string;
  postedDate?: string;
  sourceTransactionId?: string;
  sourceRow: string;
  vendorName: string;
  amountMinor: number;
  transactionType: string;
  transactionDirection: string;
  occurrenceNumber: number;
}

/** Build the versioned, unhashed identity used for CSV deduplication. */
export function importFingerprintSource(
  input: ImportFingerprintSource,
): string {
  const sourceId = input.sourceTransactionId?.trim();
  if (sourceId)
    return JSON.stringify([
      "v2",
      "source-id",
      input.accountId,
      input.transactionDate,
      sourceId,
    ]);

  return JSON.stringify([
    "v2",
    "source-row",
    input.accountId,
    input.postedDate?.trim() ?? "",
    input.transactionDate,
    input.vendorName,
    input.amountMinor,
    input.transactionType,
    input.transactionDirection,
    input.occurrenceNumber,
    input.sourceRow,
  ]);
}
