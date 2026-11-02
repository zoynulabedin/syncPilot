import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  consumeRateLimit,
  enforceActorLimit,
  enforceIngressLimit,
  rateLimitKey,
} from "../app/services/rate-limit.server";

function database(rows: Array<{ count: number }> = [{ count: 1 }]) {
  const query = vi.fn().mockResolvedValue(rows);
  return { query, db: { $queryRaw: query } as unknown as PrismaClient };
}

describe("shared request budgets", () => {
  it("returns retryable 429 and fails closed when protection is unavailable", async () => {
    const denied = database([]);
    const response = await consumeRateLimit(
      "user:write",
      "staff",
      1,
      denied.db,
    ).catch((error: unknown) => error);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(429);
    expect((response as Response).headers.get("Retry-After")).toBe("60");
    const broken = database();
    broken.query.mockRejectedValue(new Error("database connection secret"));
    const unavailable = await consumeRateLimit(
      "user:write",
      "staff",
      1,
      broken.db,
    ).catch((error: unknown) => error);
    expect((unavailable as Response).status).toBe(503);
    expect(await (unavailable as Response).text()).not.toContain("secret");
  });

  it("does not derive ingress keys from unverified tenant, token or forwarding input", async () => {
    const { query, db } = database();
    const request = new Request(
      "https://app.test/app?shop=attacker.myshopify.com",
      {
        headers: {
          "X-Forwarded-For": "spoofed",
          Authorization: "Bearer forged",
        },
      },
    );
    await Promise.all([
      enforceIngressLimit(request, "admin", db),
      enforceIngressLimit(request, "admin", db),
    ]);
    const consumes = query.mock.calls.filter((args) => args[1] !== undefined);
    expect(consumes).toHaveLength(1);
    expect(consumes[0][1]).toBe(rateLimitKey("ingress:admin", "application"));
    expect(JSON.stringify(query.mock.calls)).not.toMatch(
      /spoofed|forged|attacker/,
    );
  });

  it("uses verified shop and user identity with separate read and action budgets", async () => {
    const { query, db } = database();
    const actor = {
      shop: "a.myshopify.com",
      userId: "123",
      role: "VIEWER" as const,
    };
    const request = new Request("https://app.test/app/settings", {
      method: "POST",
    });
    await Promise.all([
      enforceActorLimit(request, actor, db),
      enforceActorLimit(request, actor, db),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toBe(rateLimitKey("shop:write", actor.shop));
    expect(query.mock.calls[1][1]).toBe(
      rateLimitKey("user:write", JSON.stringify([actor.shop, actor.userId])),
    );
    expect(query.mock.calls[1][2]).toBe(30);
    await enforceActorLimit(new Request("https://app.test/app"), actor, db);
    expect(query.mock.calls[3][1]).toBe(
      rateLimitKey("user:read", JSON.stringify([actor.shop, actor.userId])),
    );
    expect(query.mock.calls[3][2]).toBe(180);
    expect(rateLimitKey("user:read", "123")).not.toBe(
      rateLimitKey("user:write", "123"),
    );
  });
});
