import { describe, expect, it } from "vitest";
import { nextPeriod, periodContaining, periodFor } from "./month-period.js";

describe("periodFor", () => {
  it("covers the calendar month when months start on the 1st", () => {
    expect(periodFor(2026, 10, 1)).toEqual({
      year: 2026,
      month: 10,
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    expect(periodFor(2028, 2, 1).endDate).toBe("2028-02-29");
  });

  it("runs to the day before the next start day", () => {
    expect(periodFor(2026, 10, 5)).toMatchObject({ startDate: "2026-10-05", endDate: "2026-11-04" });
    expect(periodFor(2026, 12, 5)).toMatchObject({ startDate: "2026-12-05", endDate: "2027-01-04" });
  });

  it("rejects start days that not every month has", () => {
    expect(() => periodFor(2026, 2, 29)).toThrow(RangeError);
    expect(() => periodFor(2026, 2, 0)).toThrow(RangeError);
  });
});

describe("periodContaining", () => {
  it.each([
    ["2026-10-19", 1, 2026, 10],
    ["2026-10-05", 5, 2026, 10],
    ["2026-11-04", 5, 2026, 10],
    ["2026-01-03", 5, 2025, 12],
    ["2026-12-31", 28, 2026, 12],
    ["2027-01-27", 28, 2026, 12],
  ])("%s with start day %i is in %i-%i", (date, startDay, year, month) => {
    const period = periodContaining(date, startDay);
    expect(period).toMatchObject({ year, month });
    expect(date >= period.startDate && date <= period.endDate).toBe(true);
  });
});

describe("nextPeriod", () => {
  it("starts the day after the previous one ends, across years", () => {
    const dec = periodFor(2026, 12, 5);
    const jan = nextPeriod(dec, 5);
    expect(jan).toMatchObject({ year: 2027, month: 1, startDate: "2027-01-05" });
  });
});
