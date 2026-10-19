import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma.js";
import { addMember, createMess, createSlots, createUser } from "../test/factories.js";
import { toDbDate } from "../utils/date.js";
import { runMealGeneration } from "./meal-generation.job.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runMealGeneration", () => {
  it("creates today's and tomorrow's meals in each mess's timezone, once", async () => {
    // 19:00 UTC on Oct 31 is already Nov 1 in Dhaka.
    vi.setSystemTime(new Date("2026-10-31T19:00:00Z"));
    const { mess } = await createMess(await createUser());
    await createSlots(mess.id);
    await addMember(mess.id, await createUser());

    const first = await runMealGeneration();
    expect(first).toMatchObject({ created: 2 * 2 * 3, failed: 0 });

    const months = await prisma.messMonth.findMany({
      where: { messId: mess.id },
      orderBy: { startDate: "asc" },
    });
    expect(months.map((m) => m.month)).toEqual([10, 11]);
    const dates = await prisma.mealEntry.groupBy({ by: ["date"], where: { messId: mess.id } });
    expect(dates.map((d) => d.date).sort((a, b) => a.getTime() - b.getTime())).toEqual([
      toDbDate("2026-11-01"),
      toDbDate("2026-11-02"),
    ]);

    expect((await runMealGeneration()).created).toBe(0);
  });

  it("skips deleted messes", async () => {
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const { mess } = await createMess(await createUser());
    await createSlots(mess.id);
    await prisma.mess.update({ where: { id: mess.id }, data: { deletedAt: new Date() } });

    await runMealGeneration();
    expect(await prisma.mealEntry.count({ where: { messId: mess.id } })).toBe(0);
  });
});
