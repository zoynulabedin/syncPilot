import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const events = await prisma.webhookEvent.findMany({
    where: { shopDomain: session.shop },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: { id: true, topic: true, resourceId: true, status: true, receivedAt: true },
  });
  return { events: events.map((event) => ({ ...event, receivedAt: event.receivedAt.toISOString() })) };
}

export default function Activity() {
  const { events } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Sync Activity">
      <s-banner tone="info">
        This inbox records verified webhook deliveries. RECEIVED means stored,
        not synchronized. Sync processing workers will be added in the next phase.
      </s-banner>
      <s-section heading="Latest webhook events">
        {events.length === 0 ? <s-paragraph>No webhook deliveries recorded yet.</s-paragraph> : null}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th align="left">Topic</th><th align="left">Resource</th><th align="left">Status</th><th align="left">Received</th></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{event.topic}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{event.resourceId ?? "—"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{event.status}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{event.receivedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
