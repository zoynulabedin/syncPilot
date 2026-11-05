import { describe, expect, it } from "vitest";
import {
  SMALL_BODY_LIMIT,
  WEBHOOK_BODY_LIMIT,
  anonymousBodies,
  withBoundedBody,
  type BodyBudget,
} from "../app/services/request-body.server";

const KiB = 1024;
const text = (bytes: number) => new TextEncoder().encode("a".repeat(bytes));
/** Hands out `chunks` one at a time, and records how many were asked for. */
function stream(chunks: Uint8Array[], failWith?: Error) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled === chunks.length) {
          if (failWith) return controller.error(failWith);
          return controller.close();
        }
        controller.enqueue(chunks[seen.pulled++]);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, seen };
}
/** Sends `bytes`, then keeps the upload open without sending anything more. */
function stalled(bytes: number) {
  const seen = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(text(bytes));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://app.test/hook", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
const echo = (body: string) => body;
const budgetOf = (budget: Partial<BodyBudget>): BodyBudget => ({
  used: 0,
  max: 100 * KiB,
  smallReserve: 0,
  readDeadlineMs: 5_000,
  ...budget,
});

describe("reading an anonymous request body", () => {
  it("passes a body within the limit through unchanged", async () => {
    const utf8 = "產品 — bāṇglā";
    await expect(withBoundedBody(post(utf8), 1024, echo)).resolves.toBe(utf8);
    await expect(withBoundedBody(post(null), 1024, echo)).resolves.toBe("");
    // Exactly at the limit is within it.
    const { body } = stream([text(10)]);
    await expect(withBoundedBody(post(body), 10, echo)).resolves.toHaveLength(
      10,
    );
  });

  it("decodes characters split across chunks as request.text() would", async () => {
    const bytes = new TextEncoder().encode("é");
    const { body } = stream([bytes.slice(0, 1), bytes.slice(1)]);
    await expect(withBoundedBody(post(body), 10, echo)).resolves.toBe("é");
  });

  it("refuses a declared oversize body without reading any of it", async () => {
    const { body, seen } = stream([text(5)]);
    const refused = await withBoundedBody(
      post(body, { "Content-Length": "11" }),
      10,
      echo,
    ).catch((error: unknown) => error);
    expect((refused as Response).status).toBe(413);
    expect(seen.pulled).toBe(0);
  });

  it("stops at the limit when the length is missing or understated, and never runs the handler", async () => {
    for (const headers of [{}, { "Content-Length": "1" }] as Record<
      string,
      string
    >[]) {
      const { body, seen } = stream([text(6), text(6), text(6), text(6)]);
      let ran = false;
      const refused = await withBoundedBody(post(body, headers), 10, () => {
        ran = true;
      }).catch((error: unknown) => error);
      expect((refused as Response).status).toBe(413);
      expect((refused as Response).headers.get("Connection")).toBe("close");
      expect(ran).toBe(false);
      expect(seen.pulled).toBe(2);
    }
  });

  it("does not cancel the stream, which on Node would destroy the socket before the status is sent", async () => {
    const { body, seen } = stream([text(6), text(6)]);
    await withBoundedBody(post(body), 10, echo).catch(() => undefined);
    expect(seen.cancelled).toBe(false);
  });

  it("answers an interrupted upload as a client error, not a server error", async () => {
    const { body } = stream([text(1)], new Error("aborted"));
    const refused = await withBoundedBody(post(body), 10, echo).catch(
      (error: unknown) => error,
    );
    expect((refused as Response).status).toBe(400);
  });

  it("makes concurrent senders share one budget and releases it however a read ends", async () => {
    const budget = budgetOf({ max: 15 });
    // Held open: the first upload's bytes count until its handler has finished.
    let release = () => {};
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withBoundedBody(
      post(stream([text(10)]).body),
      100,
      async (body) => {
        expect(budget.used).toBe(10);
        await holding;
        return body;
      },
      budget,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refused = await withBoundedBody(
      post(stream([text(10)]).body),
      100,
      echo,
      budget,
    ).catch((error: unknown) => error);
    expect((refused as Response).status).toBe(503);
    expect((refused as Response).headers.get("Retry-After")).toBe("5");
    expect(budget.used).toBe(10);
    release();
    await expect(first).resolves.toHaveLength(10);
    expect(budget.used).toBe(0);
    // Refused and failed reads give their bytes back as well.
    await withBoundedBody(
      post(stream([text(6), text(6)]).body),
      10,
      echo,
      budget,
    ).catch(() => undefined);
    await withBoundedBody(
      post(stream([text(1)], new Error("aborted")).body),
      10,
      echo,
      budget,
    ).catch(() => undefined);
    await withBoundedBody(
      post(stream([text(1)]).body),
      10,
      () => {
        throw new Error("handler failed");
      },
      budget,
    ).catch(() => undefined);
    expect(budget.used).toBe(0);
  });

  it("stops waiting for a body that stopped arriving, and gives back what it held", async () => {
    const budget = budgetOf({ readDeadlineMs: 20 });
    const { body, seen } = stalled(5);
    let ran = false;
    const refused = await withBoundedBody(
      post(body),
      100,
      () => {
        ran = true;
      },
      budget,
    ).catch((error: unknown) => error);
    expect((refused as Response).status).toBe(408);
    expect((refused as Response).headers.get("Connection")).toBe("close");
    expect(ran).toBe(false);
    expect(seen.cancelled).toBe(false);
    expect(budget.used).toBe(0);
  });

  it("times the whole body, so a slow drip cannot keep renewing the deadline", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          sent++;
          controller.enqueue(text(300));
        },
      },
      { highWaterMark: 0 },
    );
    const budget = budgetOf({ readDeadlineMs: 40 });
    const refused = await withBoundedBody(
      post(body),
      100 * KiB,
      echo,
      budget,
    ).catch((error: unknown) => error);
    expect((refused as Response).status).toBe(408);
    expect(sent).toBeGreaterThan(1);
    expect(budget.used).toBe(0);
  });

  it("does not hold a finished body to the deadline while its handler runs", async () => {
    await expect(
      withBoundedBody(
        post("signed"),
        100,
        async (body) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return body;
        },
        budgetOf({ readDeadlineMs: 10 }),
      ),
    ).resolves.toBe("signed");
  });

  it("keeps a share of the budget that only small bodies may use", async () => {
    const shape = { max: 1024 * KiB, smallReserve: 512 * KiB };
    // Other uploads already hold everything a large body may use.
    const budget = budgetOf({ ...shape, used: 512 * KiB });
    await expect(
      withBoundedBody(
        post(stream([text(64 * KiB), text(64 * KiB)]).body),
        WEBHOOK_BODY_LIMIT,
        echo,
        budget,
      ),
    ).resolves.toHaveLength(128 * KiB);
    expect(budget.used).toBe(512 * KiB);
    // Nothing declares its size up front: a body is small until it grows past it.
    const growing = stream(Array.from({ length: 8 }, () => text(64 * KiB)));
    const refused = await withBoundedBody(
      post(growing.body),
      WEBHOOK_BODY_LIMIT,
      echo,
      budget,
    ).catch((error: unknown) => error);
    expect((refused as Response).status).toBe(503);
    expect(growing.seen.pulled).toBe(SMALL_BODY_LIMIT / (64 * KiB) + 1);
    expect(budget.used).toBe(512 * KiB);
    // A large body on its own also stops short of the reserve.
    const alone = budgetOf(shape);
    const large = stream(Array.from({ length: 16 }, () => text(64 * KiB)));
    const stopped = await withBoundedBody(
      post(large.body),
      WEBHOOK_BODY_LIMIT,
      echo,
      alone,
    ).catch((error: unknown) => error);
    expect((stopped as Response).status).toBe(503);
    expect(large.seen.pulled).toBe(9);
    expect(alone.used).toBe(0);
  });

  it("refuses small bodies too once the reserve is gone", async () => {
    const budget = budgetOf({
      max: 1024 * KiB,
      smallReserve: 512 * KiB,
      used: 1024 * KiB,
    });
    const refused = await withBoundedBody(
      post("small"),
      100,
      echo,
      budget,
    ).catch((error: unknown) => error);
    expect((refused as Response).status).toBe(503);
    expect(budget.used).toBe(budget.max);
  });

  it("gives Shopify's five second request time room, and leaves large bodies and the reserve room to work", () => {
    expect(anonymousBodies.readDeadlineMs).toBeGreaterThan(5_000);
    expect(anonymousBodies.readDeadlineMs).toBeLessThanOrEqual(10_000);
    expect(anonymousBodies.max - anonymousBodies.smallReserve).toBeGreaterThan(
      4 * WEBHOOK_BODY_LIMIT,
    );
    expect(anonymousBodies.smallReserve).toBeGreaterThanOrEqual(
      32 * SMALL_BODY_LIMIT,
    );
  });
});
