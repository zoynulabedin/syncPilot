import { clampPage, parsePage } from "../components/pagination";

export const PAGE_SIZE = 25;
export async function listPage<T>(
  requested: string | null,
  count: () => Promise<number>,
  read: (window: { take: number; skip: number }) => Promise<T[]>,
) {
  const total = await count();
  const page = clampPage(parsePage(requested), total, PAGE_SIZE);
  return {
    rows: await read({ take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    pageInfo: { total, page, pageSize: PAGE_SIZE },
  };
}
