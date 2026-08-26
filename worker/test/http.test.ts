import { describe, expect, it } from "vitest";
import { errorResponse, readJson } from "../src/http";

describe("request parsing", () => {
  it("controls malformed JSON", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    await expect(readJson(request)).rejects.toMatchObject({
      status: 400,
      code: "MALFORMED_JSON",
    });
  });
  it("turns foreign-key failures into actionable responses", async () => {
    const response = errorResponse(
      new Error("FOREIGN KEY constraint failed"),
      "request-123",
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RELATED_RECORD_MISSING", requestId: "request-123" },
    });
  });
});
