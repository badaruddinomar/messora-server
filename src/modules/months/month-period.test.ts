import { describe, expect, it } from "vitest";
import { nextPeriod, periodAfter, periodContaining, periodFor } from "./month-period.js";

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

describe("periodAfter", () => {
  it("continues normally when the start day hasn't changed", () => {
    expect(periodAfter("2026-10-31", 1)).toEqual({
      year: 2026,
      month: 11,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
    expect(periodAfter("2026-11-04", 5)).toMatchObject({
      month: 11,
      startDate: "2026-11-05",
      endDate: "2026-12-04",
    });
    expect(periodAfter("2027-01-04", 5)).toMatchObject({ year: 2027, month: 1, startDate: "2027-01-05" });
  });

  it("matches periodFor for every start day in the normal case", () => {
    for (let day = 1; day <= 28; day++) {
      const oct = periodFor(2026, 10, day);
      expect(periodAfter(oct.endDate, day)).toEqual(nextPeriod(oct, day));
    }
  });

  it("bridges to a later start day without leaving a stub month", () => {
    // Months started on the 1st; the admin switches to the 5th.
    expect(periodAfter("2026-10-31", 5)).toMatchObject({
      month: 11,
      startDate: "2026-11-01",
      endDate: "2026-12-04",
    });
  });

  it("bridges to an earlier start day", () => {
    // Months started on the 20th (Oct 20 – Nov 19); the admin switches to the 5th.
    expect(periodAfter("2026-11-19", 5)).toMatchObject({
      month: 11,
      startDate: "2026-11-20",
      endDate: "2026-12-04",
    });
    // Switching from the 28th to the 1st: Nov 28 – Nov 30 would be a stub, so it runs to Dec 31.
    expect(periodAfter("2026-11-27", 1)).toMatchObject({
      month: 11,
      startDate: "2026-11-28",
      endDate: "2026-12-31",
    });
  });

  it("never produces two months that start in the same calendar month", () => {
    for (let oldDay = 1; oldDay <= 28; oldDay++) {
      for (let newDay = 1; newDay <= 28; newDay++) {
        const first = periodFor(2026, 10, oldDay);
        const bridge = periodAfter(first.endDate, newDay);
        const after = periodAfter(bridge.endDate, newDay);
        expect(bridge.month).not.toBe(first.month);
        expect(after.month).not.toBe(bridge.month);
        expect(after.startDate.endsWith(`-${String(newDay).padStart(2, "0")}`)).toBe(true);
      }
    }
  });
});
