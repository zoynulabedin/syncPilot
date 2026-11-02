import { describe, expect, it } from "vitest";
import { clampPage, parsePage } from "../app/components/pagination";

describe("catalog and inventory URL pagination", () => {
  it.each([
    null,
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e3",
    "9007199254740993",
    "abc",
  ])("keeps malformed page %s away from Prisma offsets", (value) => {
    expect(parsePage(value)).toBe(1);
  });
  it("accepts valid pages and bounds large offsets", () => {
    expect(parsePage("2")).toBe(2);
    expect(parsePage("100001")).toBe(100_000);
  });
  it("keeps navigation on a populated page after the result set shrinks", () => {
    expect(clampPage(10, 26, 25)).toBe(2);
    expect(clampPage(3, 0, 25)).toBe(1);
    expect(clampPage(2, 50, 25)).toBe(2);
  });
});
