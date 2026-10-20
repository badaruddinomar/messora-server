import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.js";

describe("toCsv", () => {
  it("quotes cells with commas, quotes and line breaks, and starts with a BOM", () => {
    expect(toCsv(["Name", "Note"], [["Anis, Jr", 'said "hi"\nbye']])).toBe(
      '\uFEFFName,Note\r\n"Anis, Jr","said ""hi""\nbye"\r\n',
    );
  });

  it("defuses formulas but keeps negative numbers", () => {
    expect(toCsv(["a", "b", "c"], [["=HYPERLINK(1)", "-500.00", "-x"]])).toBe(
      "\uFEFFa,b,c\r\n'=HYPERLINK(1),-500.00,'-x\r\n",
    );
  });

  it("leaves empty values blank", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("\uFEFFa,b\r\n,\r\n");
  });
});
