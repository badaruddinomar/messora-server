import { describe, expect, it } from "vitest";
import { orderedIds } from "./crypto.js";

describe("orderedIds", () => {
  it("returns valid, unique UUIDv7s that sort in the order they were made", () => {
    const ids = orderedIds(300);
    expect(new Set(ids).size).toBe(300);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
