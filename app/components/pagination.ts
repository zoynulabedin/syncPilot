export function parsePage(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? Math.min(page, 100_000) : 1;
}

export function clampPage(
  page: number,
  total: number,
  pageSize: number,
): number {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}
