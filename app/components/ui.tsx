import type { ReactNode } from "react";
import type { FormProps, LinkProps, NavLinkProps } from "react-router";
import {
  Form as RouterForm,
  Link as RouterLink,
  NavLink as RouterNavLink,
  useNavigation,
  useSearchParams,
} from "react-router";

import { storePath } from "../domain/store-binding";

/** Polaris web components, on their own: App Bridge only works inside the admin. */
export const POLARIS_SCRIPT = "https://cdn.shopify.com/shopifycloud/polaris.js";

/** The store this tab is on, which its own address says. See domain/store-binding. */
export function useStore() {
  const [params] = useSearchParams();
  return params.get("shop");
}

/**
 * The dashboard's links and forms keep the tab on its store, so that one browser can
 * have two stores open and each tab goes on acting on its own. React Router's plain
 * ones would lose the store: the server would then open another store's page for a
 * link, and refuse a form outright. tests/admin-auth.test.ts keeps them out of the app.
 */
export function Link({ to, ...props }: Omit<LinkProps, "to"> & { to: string }) {
  return <RouterLink to={storePath(to, useStore())} {...props} />;
}

export function NavLink({
  to,
  ...props
}: Omit<NavLinkProps, "to"> & { to: string }) {
  return <RouterNavLink to={storePath(to, useStore())} {...props} />;
}

/**
 * A form with no action posts to the address it is on, store included. A search form
 * replaces the query with its fields, so there the store has to be one of them.
 */
export function Form({ children, action, ...props }: FormProps) {
  const store = useStore();
  const search = !props.method || props.method.toLowerCase() === "get";
  return (
    <RouterForm
      {...props}
      action={action === undefined ? action : storePath(action, store)}
    >
      {search && store && <input type="hidden" name="shop" value={store} />}
      {children}
    </RouterForm>
  );
}

export function Page({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <s-page heading={title}>
      <div className="sp-page">
        {subtitle && <p className="sp-subtitle">{subtitle}</p>}
        {action && <div className="sp-page-actions">{action}</div>}
        {children}
        <footer className="sp-footer">
          SyncPilot · Product and inventory operations{" "}
          <Link to="/app/help">Get help</Link>
        </footer>
      </div>
    </s-page>
  );
}

export function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="sp-card">
      <div className="sp-card-heading">
        <div>
          <h2>{title}</h2>
          {description && <p className="sp-muted">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  children,
  href,
  label,
}: {
  title: string;
  children?: ReactNode;
  href?: string;
  label?: string;
}) {
  return (
    <div className="sp-empty">
      <span className="sp-empty-icon" aria-hidden="true">
        ↔
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {href && (
        <Link className="sp-button" to={href}>
          {label || "Get started"}
        </Link>
      )}
    </div>
  );
}

export function Notice({
  data,
}: {
  data?: { error?: string; success?: string } | null;
}) {
  if (data?.error)
    return (
      <div className="sp-notice sp-notice-error" role="alert">
        {data.error}
      </div>
    );
  if (data?.success)
    return (
      <div className="sp-notice sp-notice-success" role="status">
        {data.success}
      </div>
    );
  return null;
}

export function Status({ value }: { value: string }) {
  const normalized = value.toUpperCase();
  const tone = [
    "CONNECTED",
    "VERIFIED",
    "COMPLETED",
    "SUCCEEDED",
    "ACTIVE",
    "APPROVED",
    "RESOLVED",
    "DELIVERED",
  ].includes(normalized)
    ? "success"
    : [
          "FAILED",
          "DEAD",
          "DEAD_LETTER",
          "UNINSTALLED",
          "REJECTED",
          "CONFLICT",
          "HELD",
        ].includes(normalized)
      ? "critical"
      : [
            "PENDING",
            "RETRY",
            "OPEN",
            "NEEDS_REVIEW",
            "PAUSED",
            "EXPIRED",
            "BLOCKED",
          ].includes(normalized)
        ? "warning"
        : "info";
  return (
    <s-badge tone={tone}>{value.replaceAll("_", " ").toLowerCase()}</s-badge>
  );
}

export function Submit({
  children,
  intent,
  value,
  secondary,
  danger,
  disabled,
}: {
  children: ReactNode;
  intent?: string;
  value?: string;
  secondary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  return (
    <button
      className={`sp-button ${secondary ? "sp-button-secondary" : ""} ${danger ? "sp-button-danger" : ""}`}
      type="submit"
      name={intent ? "intent" : undefined}
      value={intent || value}
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function InlineAction({
  intent,
  id,
  label,
  danger,
  disabled,
  confirm,
}: {
  intent: string;
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  confirm?: string;
}) {
  return (
    <Form
      method="post"
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Submit
        intent={intent}
        secondary={!danger}
        danger={danger}
        disabled={disabled}
      >
        {label}
      </Submit>
    </Form>
  );
}

export function Field({
  label,
  name,
  children,
  hint,
}: {
  label: string;
  name: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="sp-field">
      <label htmlFor={name}>{label}</label>
      {children}
      {hint && <small id={`${name}-hint`}>{hint}</small>}
    </div>
  );
}

export function Metric({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: string | number;
  detail?: string;
  href?: string;
}) {
  const body = (
    <>
      <span className="sp-metric-label">{label}</span>
      <strong>{value}</strong>
      {detail && <span className="sp-muted">{detail}</span>}
    </>
  );
  return href ? (
    <Link to={href} className="sp-metric">
      {body}
    </Link>
  ) : (
    <div className="sp-metric">{body}</div>
  );
}

export function Table({
  headings,
  children,
}: {
  headings: string[];
  children: ReactNode;
}) {
  return (
    <div
      className="sp-table-scroll"
      role="region"
      aria-label={headings.join(", ")}
    >
      <table className="sp-table">
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Time({ value }: { value: string | Date | null | undefined }) {
  if (!value) return <span className="sp-muted">Never</span>;
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Dhaka",
      })}{" "}
      BDT
    </time>
  );
}

export function Gid({ value }: { value?: string | null }) {
  return value ? (
    <span className="sp-gid" title={value}>
      {value.split("/").slice(-1)[0]}
    </span>
  ) : (
    <span className="sp-muted">—</span>
  );
}

export function ReadOnly({ canManage }: { canManage: boolean }) {
  return canManage ? null : (
    <s-banner tone="info">
      You have read-only access. A store owner must approve connection, mapping,
      and synchronization changes.
    </s-banner>
  );
}
