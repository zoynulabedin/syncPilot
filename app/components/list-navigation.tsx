import { useSearchParams } from "react-router";

import { Link } from "./ui";

/** The rest of the query, for a search form. Form in ui.tsx adds the store itself. */
export function QueryFields({ exclude = [] }: { exclude?: string[] }) {
  const [params] = useSearchParams();
  return (
    <>
      {[...params]
        .filter(([key]) => key !== "shop" && !exclude.includes(key))
        .map(([key, value], index) => (
          <input
            key={`${key}:${index}`}
            type="hidden"
            name={key}
            value={value}
          />
        ))}
    </>
  );
}

export function Pagination({
  info,
  param,
  label,
}: {
  info: { page: number; pageSize: number; total: number };
  param: string;
  label: string;
}) {
  const [params] = useSearchParams();
  const href = (page: number) => {
    const next = new URLSearchParams(params);
    next.set(param, String(page));
    return `?${next}`;
  };
  return (
    <nav className="sp-pagination" aria-label={`${label} pages`}>
      <span>
        {info.total} {label} · Page {info.page} of{" "}
        {Math.max(1, Math.ceil(info.total / info.pageSize))}
      </span>
      <div className="sp-actions">
        {info.page > 1 && (
          <Link
            className="sp-button sp-button-secondary"
            to={href(info.page - 1)}
          >
            Previous
          </Link>
        )}
        {info.page * info.pageSize < info.total && (
          <Link
            className="sp-button sp-button-secondary"
            to={href(info.page + 1)}
          >
            Next
          </Link>
        )}
      </div>
    </nav>
  );
}
