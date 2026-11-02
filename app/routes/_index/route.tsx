import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SyncPilot</h1>
        <p className={styles.text}>
          Secure product and inventory synchronization for your Shopify stores.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Verified store connections.</strong> Both owners approve
            pairing before sharing catalog data.
          </li>
          <li>
            <strong>Reviewable changes.</strong> Map stable product identities,
            choose field ownership, and inspect each dry run.
          </li>
          <li>
            <strong>Controlled inventory.</strong> Use explicit source
            authority, mapped locations, safety buffers, and quantity
            preconditions.
          </li>
        </ul>
      </div>
    </div>
  );
}
