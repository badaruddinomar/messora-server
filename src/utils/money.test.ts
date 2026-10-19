import { describe, expect, it } from "vitest";
import { roundMoney, splitByWeight, splitEqually, sumMoney } from "./money.js";

const asStrings = (parts: Map<string, { toFixed: (n: number) => string }>) =>
  Object.fromEntries([...parts].map(([k, v]) => [k, v.toFixed(2)]));

describe("roundMoney", () => {
  it("rounds half up to cents", () => {
    expect(roundMoney("10.005").toFixed(2)).toBe("10.01");
    expect(roundMoney("10.004").toFixed(2)).toBe("10.00");
    expect(roundMoney("-10.005").toFixed(2)).toBe("-10.01");
  });
});

describe("sumMoney", () => {
  it("adds decimals exactly (no float drift)", () => {
    expect(sumMoney(["0.1", "0.2"]).toFixed(2)).toBe("0.30");
    expect(sumMoney([]).toFixed(2)).toBe("0.00");
  });
});

describe("splitEqually", () => {
  it("gives leftover cents to the first keys and always adds up to the total", () => {
    const parts = splitEqually("100", ["a", "b", "c"]);
    expect(asStrings(parts)).toEqual({ a: "33.34", b: "33.33", c: "33.33" });
    expect(sumMoney(parts.values()).toFixed(2)).toBe("100.00");
  });

  it("splits evenly when possible", () => {
    expect(asStrings(splitEqually("90", ["a", "b", "c"]))).toEqual({ a: "30.00", b: "30.00", c: "30.00" });
  });

  it("handles a single key and an empty list", () => {
    expect(asStrings(splitEqually("12.34", ["a"]))).toEqual({ a: "12.34" });
    expect(splitEqually("10", []).size).toBe(0);
  });

  it("splits negative totals (adjustments) exactly", () => {
    const parts = splitEqually("-100", ["a", "b", "c"]);
    expect(sumMoney(parts.values()).toFixed(2)).toBe("-100.00");
  });
});

describe("splitByWeight", () => {
  it("splits proportionally to weights (e.g. meal counts)", () => {
    const parts = splitByWeight("1000", [
      { key: "a", weight: "30" },
      { key: "b", weight: "20" },
      { key: "c", weight: "50" },
    ]);
    expect(asStrings(parts)).toEqual({ a: "300.00", b: "200.00", c: "500.00" });
  });

  it("allocates leftover cents by largest remainder", () => {
    // Exact shares of 10.00 at 2.5 : 1 : 1 are 5.555.., 2.222.., 2.222.. → floors leave 1 cent,
    // which goes to the largest remainder (a).
    const parts = splitByWeight("10", [
      { key: "a", weight: "2.5" },
      { key: "b", weight: "1" },
      { key: "c", weight: "1" },
    ]);
    expect(asStrings(parts)).toEqual({ a: "5.56", b: "2.22", c: "2.22" });
    expect(sumMoney(parts.values()).toFixed(2)).toBe("10.00");
  });

  it("always adds up to the total for awkward inputs", () => {
    const weights = [7, 13, 0.5, 2.25, 9, 1].map((weight, i) => ({ key: i, weight }));
    for (const total of ["0.01", "1", "99.99", "12345.67", "3333.33"]) {
      expect(sumMoney(splitByWeight(total, weights).values()).toFixed(2)).toBe(roundMoney(total).toFixed(2));
    }
  });

  it("gives a zero weight nothing", () => {
    const parts = splitByWeight("50", [
      { key: "a", weight: 1 },
      { key: "b", weight: 0 },
    ]);
    expect(asStrings(parts)).toEqual({ a: "50.00", b: "0.00" });
  });

  it("falls back to an equal split when every weight is zero", () => {
    const parts = splitByWeight("10", [
      { key: "a", weight: 0 },
      { key: "b", weight: 0 },
    ]);
    expect(asStrings(parts)).toEqual({ a: "5.00", b: "5.00" });
  });

  it("rejects negative weights", () => {
    expect(() =>
      splitByWeight("10", [
        { key: "a", weight: 5 },
        { key: "b", weight: -1 },
      ]),
    ).toThrow(RangeError);
  });
});
