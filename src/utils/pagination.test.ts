import { describe, expect, it } from "vitest";
import { cursorArgs, paginationQuery, toPage } from "./pagination.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i + 1}` }));

describe("paginationQuery", () => {
  it("applies defaults and coerces strings", () => {
    expect(paginationQuery.parse({})).toEqual({ limit: 20 });
    expect(paginationQuery.parse({ limit: "5", cursor: "abc" })).toEqual({ limit: 5, cursor: "abc" });
  });

  it("caps the page size", () => {
    expect(paginationQuery.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("cursorArgs", () => {
  it("fetches one extra row and skips the cursor row", () => {
    expect(cursorArgs({ limit: 10 })).toEqual({ take: 11 });
    expect(cursorArgs({ limit: 10, cursor: "x" })).toEqual({ take: 11, cursor: { id: "x" }, skip: 1 });
  });
});

describe("toPage", () => {
  it("returns a next cursor only when there are more rows", () => {
    expect(toPage(rows(11), 10)).toEqual({ items: rows(10), nextCursor: "id-10" });
    expect(toPage(rows(10), 10)).toEqual({ items: rows(10), nextCursor: null });
    expect(toPage([], 10)).toEqual({ items: [], nextCursor: null });
  });
});
