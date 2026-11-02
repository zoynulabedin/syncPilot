import { describe, expect, it } from "vitest";
import { assertStockConserved, MAX_STOCK, stockCapacity, stockQuantity } from "../app/domain/stock-ledger";

describe("central physical stock conservation", () => {
  it("bounds every allowance by unreserved stock after its buffer", () => {
    expect(assertStockConserved({ physical: 100, reserved: 15, safetyBuffer: 5 }, [30, 40])).toEqual({ capacity: 80, allocated: 70, unallocated: 10 });
    expect(() => assertStockConserved({ physical: 100, reserved: 15, safetyBuffer: 5 }, [41, 40])).toThrow("Reduce allocations");
  });
  it("rejects negative, fractional, nonfinite and overflowing quantities", () => {
    for (const value of [-1, 0.5, Infinity, NaN, MAX_STOCK + 1]) expect(() => stockQuantity(value)).toThrow();
    expect(() => stockQuantity(0, true)).toThrow();
    expect(stockQuantity(MAX_STOCK)).toBe(MAX_STOCK);
  });
  it("holds a physical adjustment below active reservations", () => {
    expect(() => stockCapacity(2, 3, 0)).toThrow("existing reservations");
    expect(stockCapacity(2, 0, 10)).toBe(0);
    expect(() => assertStockConserved({ physical: 2, reserved: 0, safetyBuffer: 10 }, [1])).toThrow();
  });
});
