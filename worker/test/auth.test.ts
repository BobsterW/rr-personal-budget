import { describe, expect, it } from "vitest";
import {
  normalizeUsername,
  passwordHash,
  passwordMatches,
  validatePassword,
  validateUsername,
} from "../src/auth";

describe("authentication", () => {
  it("normalizes usernames and enforces the registration policy", () => {
    expect(normalizeUsername("  Bobby.Name ")).toBe("bobby.name");
    expect(validateUsername("Bobby_Name")).toBe("Bobby_Name");
    expect(() => validatePassword("lowercase1!")).toThrow(/capital letter/);
    expect(() => validatePassword("NoNumber!")).toThrow(/number/);
    expect(() => validatePassword("NoSpecial1")).toThrow(/special/);
    expect(validatePassword("ValidPass1!")).toBe("ValidPass1!");
  });

  it("stores passwords as salted bcrypt hashes", async () => {
    const first = await passwordHash("ValidPass1!");
    const second = await passwordHash("ValidPass1!");
    expect(first).toMatch(/^\$2[aby]\$12\$/);
    expect(first).not.toBe(second);
    await expect(passwordMatches("ValidPass1!", first)).resolves.toBe(true);
    await expect(passwordMatches("WrongPass1!", first)).resolves.toBe(false);
  });
});
