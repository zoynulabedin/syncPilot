import { Form, useSearchParams } from "react-router";

import styles from "./sign-in-screen.module.css";

const POINTS = [
  {
    title: "Verified store connections",
    text: "Both store owners approve before any catalog data is shared.",
  },
  {
    title: "Reviewable changes",
    text: "Choose which fields sync and check a preview before you approve it.",
  },
  {
    title: "Controlled inventory",
    text: "You pick the source store, the locations and a safety buffer.",
  },
];

/**
 * The first screen of the app, wherever a person arrives: the landing page, the
 * login form, and a sign-in or a link that was refused. It loads nothing from
 * anywhere else, so it needs neither Polaris nor Shopify's CDN to appear.
 */
export function SignInScreen({
  action,
  error,
  typed,
  confirming,
  signedIn = [],
}: {
  /** Where the form posts. By default the page's own address, return_to included. */
  action?: string;
  error?: string;
  /** What the person entered, so a typing mistake does not cost them the rest of it. */
  typed?: string;
  /** A link named this store: no sign-in starts until the person chooses it here. */
  confirming?: string;
  /** Stores this browser still has a session for, so signing out of one says so. */
  signedIn?: string[];
}) {
  const [params] = useSearchParams();
  const returnTo = params.get("return_to");
  return (
    <main className={styles.screen}>
      <section className={styles.card} aria-labelledby="sign-in-heading">
        <div className={styles.brand}>
          <svg
            className={styles.mark}
            viewBox="0 0 32 32"
            width="32"
            height="32"
            aria-hidden="true"
          >
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path
              d="M9 13h12m0 0-3.5-3.5M21 13l-3.5 3.5M23 19H11m0 0 3.5-3.5M11 19l3.5 3.5"
              fill="none"
              stroke="var(--si-on-accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>SyncPilot</span>
        </div>
        <h1 id="sign-in-heading" className={styles.heading}>
          {confirming ? "Sign in to this store?" : "Sign in to SyncPilot"}
        </h1>
        <p className={styles.lead}>
          {confirming
            ? `A link asked to open ${confirming}. Continue if you meant to sign in to it with your Shopify account. Any other store you are signed in to on this browser stays signed in.`
            : "You sign in with your Shopify account. SyncPilot never sees your password."}
        </p>
        {/* A whole-page post: the answer sends this browser on to Shopify. */}
        <Form
          className={styles.form}
          method="post"
          action={action}
          reloadDocument
        >
          {returnTo && (
            <input type="hidden" name="return_to" value={returnTo} />
          )}
          <label className={styles.label} htmlFor="sign-in-shop">
            Store domain
          </label>
          <input
            className={styles.input}
            id="sign-in-shop"
            name="shop"
            type="text"
            defaultValue={confirming ?? typed}
            placeholder="your-store.myshopify.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="on"
            inputMode="url"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
          {error && (
            <p id="sign-in-error" className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button className={styles.button} type="submit">
            Continue with Shopify
          </button>
        </Form>
        {confirming && (
          <div>
            <a className={styles.privacy} href="/">
              Not now
            </a>
          </div>
        )}
        {signedIn.length > 0 && (
          <section className={styles.stores} aria-label="Signed in already">
            <p className={styles.lead}>Signed in on this browser already:</p>
            <ul className={styles.storeList}>
              {signedIn.map((store) => (
                <li key={store}>
                  <a
                    className={styles.privacy}
                    href={`/app?${new URLSearchParams({ shop: store })}`}
                  >
                    {store}
                  </a>
                </li>
              ))}
            </ul>
            {/* Naming no store signs this browser out of all of them. */}
            <form method="post" action="/auth/logout">
              <button className={styles.quietButton} type="submit">
                Sign out of all of them
              </button>
            </form>
          </section>
        )}
        <a className={styles.privacy} href="/privacy">
          How SyncPilot handles your data
        </a>
      </section>
      <aside className={styles.panel} aria-label="About SyncPilot">
        <p className={styles.description}>
          Keep products and inventory in step across your Shopify stores.
        </p>
        <ul className={styles.points}>
          {POINTS.map(({ title, text }) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}
