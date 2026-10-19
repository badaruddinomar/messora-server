import { describe, expect, it } from "vitest";
import { emailField, phoneField } from "./auth.schema.js";

describe("phoneField", () => {
  it.each([
    ["01712345678", "+8801712345678"],
    ["+8801712345678", "+8801712345678"],
    ["+880 1712-345678", "+8801712345678"],
    ["(017) 1234 5678", "+8801712345678"],
    ["+14155552671", "+14155552671"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(phoneField.parse(input)).toBe(expected);
  });

  it.each(["12", "abc", "+0123456789", "017123"])("rejects %s", (input) => {
    expect(phoneField.safeParse(input).success).toBe(false);
  });
});

describe("emailField", () => {
  it("trims and lowercases", () => {
    expect(emailField.parse("  Rahim@Example.COM ")).toBe("rahim@example.com");
  });
});
