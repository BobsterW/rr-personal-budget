import { describe, expect, it } from "vitest";
import {
  inferDateOrder,
  normalizeImportDate,
} from "../../frontend/src/date.js";

describe("CSV date normalization", () => {
  it("infers Cornerstone month/day/year dates from the whole column", () => {
    const values = ["08/31/2026", "08/24/2026", "08/04/2026"];
    const order = inferDateOrder(values);
    expect(order).toBe("mdy");
    expect(normalizeImportDate(values[0], "auto", order)).toEqual({
      value: "2026-08-31",
      error: "",
    });
  });

  it("supports ISO and explicitly selected day/month/year dates", () => {
    expect(normalizeImportDate("2026-09-04").value).toBe("2026-09-04");
    expect(normalizeImportDate("31/08/2026", "dmy").value).toBe("2026-08-31");
  });

  it("rejects ambiguous and impossible dates", () => {
    expect(normalizeImportDate("04/05/2026").error).toMatch(/ambiguous/);
    expect(normalizeImportDate("02/30/2026", "mdy").error).toMatch(
      /real calendar date/,
    );
  });
});
