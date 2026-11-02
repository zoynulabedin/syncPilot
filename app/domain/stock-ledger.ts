import { DomainError } from "./errors";

export const MAX_STOCK = 2_147_483_647;

export function stockQuantity(value: number, positive = false) {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > MAX_STOCK)
    throw new DomainError("INVALID_STOCK", "Stock quantities must be nonnegative whole numbers within the supported range.");
  return value;
}

/** Allocations are the unsold allowances; reservations consume those allowances. */
export function stockCapacity(physical: number, reserved: number, safetyBuffer: number) {
  [physical, reserved, safetyBuffer].forEach((value) => stockQuantity(value));
  if (reserved > physical)
    throw new DomainError("STOCK_OVERCOMMITTED", "Physical stock cannot be less than existing reservations.", 409);
  return Math.max(0, physical - reserved - safetyBuffer);
}

export function assertStockConserved(
  state: { physical: number; reserved: number; safetyBuffer: number },
  allocations: number[],
) {
  const capacity = stockCapacity(state.physical, state.reserved, state.safetyBuffer);
  let allocated = 0;
  for (const value of allocations) {
    allocated += stockQuantity(value);
    if (allocated > capacity)
      throw new DomainError("STOCK_OVERCOMMITTED", "Reduce allocations or add physical stock before committing this change.", 409);
  }
  return { capacity, allocated, unallocated: capacity - allocated };
}
