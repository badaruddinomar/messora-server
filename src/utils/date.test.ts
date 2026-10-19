import { describe, expect, it } from "vitest";
import {
  addDays,
  daysInclusive,
  fromDbDate,
  isDateString,
  toDbDate,
  todayIn,
  zonedDateTime,
} from "./date.js";

describe("todayIn", () => {
  it("uses the mess timezone, not UTC", () => {
    // 20:00 UTC on Oct 19 is already Oct 20 in Dhaka (UTC+6).
    const now = new Date("2026-10-19T20:00:00Z");
    expect(todayIn("Asia/Dhaka", now)).toBe("2026-10-20");
    expect(todayIn("UTC", now)).toBe("2026-10-19");
  });
});

describe("toDbDate / fromDbDate", () => {
  it("round-trips calendar days through UTC midnight", () => {
    const db = toDbDate("2026-02-28");
    expect(db.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(fromDbDate(db)).toBe("2026-02-28");
  });

  it("rejects invalid dates", () => {
    expect(() => toDbDate("2026-13-01")).toThrow(RangeError);
    expect(() => toDbDate("19/10/2026")).toThrow(RangeError);
    expect(isDateString("2026-10-19")).toBe(true);
    expect(isDateString("2026-1-9")).toBe(false);
  });
});

describe("addDays / daysInclusive", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("counts both ends", () => {
    expect(daysInclusive("2026-10-01", "2026-10-31")).toBe(31);
    expect(daysInclusive("2026-10-05", "2026-10-05")).toBe(1);
  });
});

describe("zonedDateTime", () => {
  it("converts a mess-local wall-clock time to the exact instant", () => {
    expect(zonedDateTime("2026-10-19", "10:30", "Asia/Dhaka").toISOString()).toBe("2026-10-19T04:30:00.000Z");
    expect(zonedDateTime("2026-10-19", "00:00", "UTC").toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
});
