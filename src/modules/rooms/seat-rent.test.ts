import { describe, expect, it } from "vitest";
import { toDbDate } from "../../utils/date.js";
import { seatRent } from "./seat-rent.js";

const october = { startDate: toDbDate("2026-10-01"), endDate: toDbDate("2026-10-31") };
const member = (joined: string, left?: string) => ({
  joinedAt: toDbDate(joined),
  leftAt: left ? toDbDate(left) : null,
});

describe("seatRent", () => {
  it("charges the full rent for the whole month", () => {
    expect(seatRent(3100, member("2026-09-01"), october, true)).toMatchObject({
      isProrated: false,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
    });
    expect(seatRent(3100, member("2026-09-01"), october, true)!.amount.toFixed(2)).toBe("3100.00");
  });

  it("prorates a mid-month join or leave by days present", () => {
    const joined = seatRent(3100, member("2026-10-22"), october, true)!;
    expect(joined).toMatchObject({
      daysPresent: 10,
      daysInMonth: 31,
      isProrated: true,
      periodFrom: "2026-10-22",
    });
    expect(joined.amount.toFixed(2)).toBe("1000.00");

    const left = seatRent(3000, member("2026-01-01", "2026-10-10"), october, true)!;
    expect(left.amount.toFixed(2)).toBe("967.74"); // 3000 × 10 / 31
    expect(left.periodTo).toBe("2026-10-10");
  });

  it("charges the full rent when proration is off, and nothing outside the month", () => {
    expect(seatRent(3000, member("2026-10-22"), october, false)!.amount.toFixed(2)).toBe("3000.00");
    expect(seatRent(3000, member("2026-11-02"), october, true)).toBeNull();
    expect(seatRent(3000, member("2026-01-01", "2026-09-30"), october, true)).toBeNull();
    expect(seatRent(3000, { joinedAt: null, leftAt: null }, october, true)).toBeNull();
  });
});
