import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The default client stays empty, so a real service call fails on any lookup
// the test did not stub.
const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  auth: vi.fn(),
  consents: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../app/db.server", () => ({ default: mocks.prisma }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));
vi.mock("../app/services/automatic-sync.server", () => ({
  getAutomaticConsents: mocks.consents,
  grantAutomaticConsent: mocks.grant,
  revokeAutomaticConsent: mocks.revoke,
}));
import { actionFailure } from "../app/components/actions.server";
import { CONSENT_LIMITS } from "../app/domain/automatic-limits";
import { AUTOMATIC_FIELDS } from "../app/domain/automation";
import { DomainError } from "../app/domain/guards";
import { SyncError } from "../app/domain/sync";
import type { Actor } from "../app/services/authorization.server";
import AutomaticSync, {
  action,
  loader,
} from "../app/routes/app.automatic-sync";

type Service = typeof import("../app/services/automatic-sync.server");
const service = () =>
  vi.importActual<Service>("../app/services/automatic-sync.server");

const shop = "consent-source.myshopify.com";
const partner = "consent-target.myshopify.com";
const owner: Actor = { shop, userId: "101", role: "OWNER" };
const staff: Actor = { shop, userId: "202", role: "VIEWER" };
const signIn = (actor: Actor) =>
  mocks.auth.mockResolvedValue({
    session: {
      shop: actor.shop,
      onlineAccessInfo: {
        associated_user: {
          id: Number(actor.userId),
          account_owner: actor.role === "OWNER",
        },
      },
    },
  });
const gates = (automatic: string, writes: string) => {
  vi.stubEnv("AUTOMATIC_SYNC_ENABLED", automatic);
  vi.stubEnv("SYNC_WRITE_ENABLED", writes);
};

const url = "https://sync.example.invalid/app/automatic-sync";
const route = {
  url: new URL(url),
  pattern: "/app/automatic-sync",
  params: {},
  context: {},
};
const get = (): LoaderFunctionArgs => ({ ...route, request: new Request(url) });
const post = (fields: Record<string, string>): ActionFunctionArgs => ({
  ...route,
  request: new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }),
});

const unconfirmed = {
  intent: "grant",
  policyId: "policy-1",
  previewId: "preview-1",
  durationMinutes: "60",
  intervalMinutes: " 15 ",
  maxJobs: "4",
  maxChanges: "50",
  perRunChanges: "25",
};
const grantForm = { ...unconfirmed, confirmed: "on" };
const grantInput = {
  policyId: "policy-1",
  previewId: "preview-1",
  durationMinutes: 60,
  intervalMinutes: 15,
  maxJobs: 4,
  maxChanges: 50,
  perRunChanges: 25,
  confirmed: true,
};

const policy = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace-1",
  sourceShopDomain: shop,
  targetShopDomain: partner,
  enabled: true,
  status: "ACTIVE",
  approvedAt: new Date("2026-11-01T00:00:00Z"),
  approvedBy: `${shop}:101`,
  direction: "ONE_WAY",
  syncInventory: false,
  syncPrices: false,
  syncVariants: false,
  syncProduct: true,
  fields: ["title", "tags"],
  ...overrides,
});
const consent = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace-1",
  policyId: "policy-auto",
  status: "ACTIVE",
  fields: ["title", "tags"],
  approvedBy: `${shop}:101`,
  usedJobs: 0,
  maxJobs: 4,
  usedChanges: 0,
  maxChanges: 50,
  perRunChanges: 25,
  intervalMinutes: 15,
  nextRunAt: new Date(Date.now() + 10 * 60_000),
  expiresAt: new Date(Date.now() + 60 * 60_000),
  revokedAt: null,
  createdAt: new Date(),
  ...overrides,
});
const titleChanges = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: "PRODUCT",
    field: "title",
    sourceId: `gid://shopify/Product/${index + 1}`,
    targetId: `gid://shopify/Product/${index + 1001}`,
    before: "Old title",
    after: "New title",
  }));
const preview = (id: string, policyId: string, changes: unknown[]) => ({
  id,
  workspaceId: "workspace-1",
  policyId,
  status: "PENDING",
  changes,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 15 * 60_000),
});

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];
});
afterEach(() => vi.unstubAllEnvs());

describe("automatic sync loader", () => {
  it("returns the consent view and deployment gate for the signed-in actor", async () => {
    signIn(owner);
    mocks.consents.mockResolvedValue({ paired: true, enabled: false });
    await expect(loader(get())).resolves.toMatchObject({
      paired: true,
      enabled: false,
      observedNow: expect.any(Number),
    });
    expect(mocks.consents).toHaveBeenCalledWith(owner);
  });

  it("renders an unpaired store for owners and staff without workspace lookups", async () => {
    const { getAutomaticConsents } = await service();
    mocks.consents.mockImplementation(getAutomaticConsents);
    // Only the installation upsert is answered; any workspace query would fail.
    const upsert = vi.fn().mockResolvedValue({
      shopDomain: shop,
      workspaceId: null,
      status: "CONNECTED",
      uninstalledAt: null,
    });
    Object.assign(mocks.prisma, { shopConnection: { upsert } });
    for (const actor of [owner, staff]) {
      signIn(actor);
      await expect(loader(get())).resolves.toMatchObject({
        paired: false,
        consents: [],
        policies: [],
        previews: [],
        automaticFields: [...AUTOMATIC_FIELDS],
        canManage: actor.role === "OWNER",
        enabled: false,
      });
    }
    // Opening the page records the visit, as the other pages do. Coming back
    // from an uninstall is decided separately, against the store's sessions.
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const [query] of upsert.mock.calls)
      expect(query).toEqual({
        where: { shopDomain: shop },
        create: { shopDomain: shop },
        update: { lastSeenAt: expect.any(Date) },
      });
  });

  it('opens the gate only when both deployment switches are exactly "true"', async () => {
    const { getAutomaticConsents } = await service();
    mocks.consents.mockImplementation(getAutomaticConsents);
    Object.assign(mocks.prisma, {
      shopConnection: {
        upsert: vi.fn().mockResolvedValue({
          shopDomain: shop,
          workspaceId: null,
          status: "CONNECTED",
          uninstalledAt: null,
        }),
      },
    });
    signIn(owner);
    for (const [automatic, writes, open] of [
      ["true", "true", true],
      ["true", "false", false],
      ["false", "true", false],
      ["TRUE", "true", false],
      [" true", "true", false],
      ["1", "true", false],
      ["true", "True", false],
      ["", "", false],
    ] as const) {
      gates(automatic, writes);
      await expect(loader(get())).resolves.toMatchObject({ enabled: open });
    }
  });

  it("offers previews only for eligible policies but lists every policy and budget", async () => {
    const { getAutomaticConsents } = await service();
    mocks.consents.mockImplementation(getAutomaticConsents);
    const policies = [
      policy("policy-auto"),
      policy("policy-handle", { fields: ["title", "handle"] }),
      policy("policy-paused", { enabled: false, status: "PAUSED" }),
      policy("policy-stock", { syncInventory: true }),
    ];
    const consents = [
      consent("consent-runs", { usedJobs: 4, usedChanges: 10 }),
      consent("consent-changes", { usedJobs: 1, usedChanges: 50 }),
      consent("consent-held", {
        policyId: "policy-paused",
        status: "HELD",
        usedJobs: 1,
        usedChanges: 3,
      }),
    ];
    const previews = [preview("preview-1", "policy-auto", titleChanges(2))];
    const findPreviews = vi.fn().mockResolvedValue(previews);
    const connection = {
      shopDomain: shop,
      workspaceId: "workspace-1",
      status: "CONNECTED",
      uninstalledAt: null,
    };
    Object.assign(mocks.prisma, {
      shopConnection: {
        upsert: vi.fn().mockResolvedValue(connection),
        findUnique: vi.fn().mockResolvedValue(connection),
        findMany: vi
          .fn()
          .mockResolvedValue([{ shopDomain: shop }, { shopDomain: partner }]),
      },
      workspace: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "workspace-1", state: "ACTIVE" }),
      },
      workspaceMember: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ status: "ACTIVE", role: "VIEWER" }),
      },
      storePair: {
        findFirst: vi.fn().mockResolvedValue({
          id: "pair-1",
          sourceShop: shop,
          targetShop: partner,
          status: "VERIFIED",
        }),
      },
      automaticConsent: { findMany: vi.fn().mockResolvedValue(consents) },
      syncPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
      syncPreview: { findMany: findPreviews },
    });
    gates("true", "true");
    for (const actor of [owner, staff]) {
      signIn(actor);
      const page = await loader(get());
      expect(page).toMatchObject({
        paired: true,
        canManage: actor.role === "OWNER",
        enabled: true,
        previews,
      });
      expect(page.policies.map(({ id, eligible }) => [id, eligible])).toEqual([
        ["policy-auto", true],
        ["policy-handle", false],
        ["policy-paused", false],
        ["policy-stock", false],
      ]);
      expect(page.consents.map(({ id, exhausted }) => [id, exhausted])).toEqual(
        [
          ["consent-runs", true],
          ["consent-changes", true],
          ["consent-held", false],
        ],
      );
    }
    expect(findPreviews).toHaveBeenCalledTimes(2);
    for (const [query] of findPreviews.mock.calls)
      expect(query.where).toEqual({
        workspaceId: "workspace-1",
        policyId: { in: ["policy-auto"] },
        status: { in: ["PENDING", "APPLIED"] },
        expiresAt: { gt: expect.any(Date) },
      });
  });
});

describe("automatic sync actions", () => {
  it("maps the grant form to the exact consent input", async () => {
    signIn(owner);
    mocks.grant.mockResolvedValue({ id: "consent-1" });
    await expect(action(post(grantForm))).resolves.toEqual({
      success: expect.any(String),
    });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(mocks.grant.mock.calls[0]).toStrictEqual([owner, grantInput]);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("refuses to grant unless the confirmation box is checked", async () => {
    signIn(owner);
    for (const form of [
      unconfirmed,
      ...["", "false", "off"].map((confirmed) => ({
        ...unconfirmed,
        confirmed,
      })),
    ])
      await expect(action(post(form))).resolves.toEqual({
        error: expect.stringContaining("Confirm"),
      });
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("revokes the submitted consent", async () => {
    signIn(owner);
    await expect(
      action(post({ intent: "revoke", id: " consent-1 " })),
    ).resolves.toEqual({ success: expect.any(String) });
    expect(mocks.revoke.mock.calls).toStrictEqual([[owner, "consent-1"]]);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("rejects unknown intents without calling a service", async () => {
    signIn(owner);
    for (const intent of ["", "GRANT", "approve", "activate", "delete"])
      await expect(
        action(post({ ...grantForm, intent, id: "consent-1" })),
      ).resolves.toEqual({ error: "Choose a valid automatic sync action." });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("returns the shared failure response for domain errors", async () => {
    signIn(owner);
    const error = new DomainError(
      "PREVIEW_REQUIRED",
      "Review a fresh exact preview for this policy before granting consent.",
      409,
    );
    mocks.grant.mockRejectedValue(error);
    const result = await action(post(grantForm));
    expect(result).toEqual(actionFailure(error));
    expect(result).toMatchObject({
      data: { error: error.message },
      init: { status: 409 },
    });
    mocks.revoke.mockRejectedValue(
      new DomainError("CONSENT_NOT_FOUND", "Consent not found.", 404),
    );
    await expect(
      action(post({ intent: "revoke", id: "missing" })),
    ).resolves.toMatchObject({
      data: { error: "Consent not found." },
      init: { status: 404 },
    });
  });

  it("shows consent check messages but hides unexpected failures", async () => {
    signIn(owner);
    mocks.grant.mockRejectedValueOnce(
      new SyncError(
        "CONSENT_BUDGET",
        "This comparison exceeds the owner's remaining automatic change budget.",
      ),
    );
    await expect(action(post(grantForm))).resolves.toMatchObject({
      data: {
        error:
          "This comparison exceeds the owner's remaining automatic change budget.",
      },
      init: { status: 409 },
    });
    mocks.grant.mockRejectedValueOnce(new Error("connection reset by peer"));
    const hidden = await action(post(grantForm));
    expect(hidden).toMatchObject({ init: { status: 500 } });
    expect(JSON.stringify(hidden)).not.toContain("connection reset");
  });

  it("keeps grant and revoke owner-only on the server, even with the gate open", async () => {
    const { grantAutomaticConsent, revokeAutomaticConsent } = await service();
    mocks.grant.mockImplementation(grantAutomaticConsent);
    mocks.revoke.mockImplementation(revokeAutomaticConsent);
    gates("true", "true");
    signIn(staff);
    // mocks.prisma stays empty: the refusal comes before any database access.
    for (const fields of [grantForm, { intent: "revoke", id: "consent-1" }])
      await expect(action(post(fields))).resolves.toMatchObject({
        data: { error: "A verified store owner must approve this operation." },
        init: { status: 403 },
      });
    expect(mocks.grant).toHaveBeenCalledWith(staff, grantInput);
    expect(mocks.revoke).toHaveBeenCalledWith(staff, "consent-1");
  });
});

type PageData = Awaited<ReturnType<typeof loader>>;
const render = (data: Partial<Record<keyof PageData, unknown>>) => {
  const Stub = createRoutesStub([
    { id: "page", path: "/app/automatic-sync", Component: AutomaticSync },
  ]);
  const page = {
    automaticFields: [...AUTOMATIC_FIELDS],
    canManage: true,
    enabled: true,
    paired: true,
    consents: [],
    policies: [],
    previews: [],
    observedNow: Date.now(),
    ...data,
  };
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/app/automatic-sync"],
      hydrationData: { loaderData: { page } },
    }),
  );
};
const input = (html: string, id: string) =>
  html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

describe("automatic sync page", () => {
  const nextRunAt = new Date(Date.now() + 10 * 60_000);
  const scheduled = {
    ...consent("consent-1", { nextRunAt }),
    exhausted: false,
  };
  const policies = [{ ...policy("policy-auto"), eligible: true }];

  it("shows the next run only while the deployment switch is on", () => {
    const on = render({ consents: [scheduled], policies });
    expect(on).toContain(nextRunAt.toISOString());
    expect(on).not.toContain("Paused by the deployment switch");
    const off = render({ consents: [scheduled], policies, enabled: false });
    expect(off).not.toContain(nextRunAt.toISOString());
    expect(off).toContain("Paused by the deployment switch");
    // Revoke stays available, the grant form does not.
    expect(off).toContain('value="revoke"');
    expect(off).not.toContain("Grant automatic consent");
    const spent = render({
      consents: [{ ...scheduled, exhausted: true }],
      policies,
    });
    expect(spent).not.toContain(nextRunAt.toISOString());
    expect(spent).toContain("Next run —");
  });

  it("offers only plans the change limits can cover and sizes their defaults", () => {
    const html = render({
      policies,
      previews: [
        preview("preview-fits", "policy-auto", titleChanges(60)),
        preview(
          "preview-large",
          "policy-auto",
          titleChanges(CONSENT_LIMITS.perRunChanges.max + 1),
        ),
      ],
    });
    expect(html).toContain('value="preview-fits"');
    expect(html).not.toContain('value="preview-large"');
    expect(html).toContain("1 other fresh plans");
    expect(input(html, "policy-auto-perRunChanges")).toContain('value="60"');
    expect(input(html, "policy-auto-maxChanges")).toContain('value="60"');
    // A small plan keeps the standard defaults.
    const small = render({
      policies,
      previews: [preview("preview-small", "policy-auto", titleChanges(3))],
    });
    expect(input(small, "policy-auto-perRunChanges")).toContain('value="25"');
    expect(input(small, "policy-auto-maxChanges")).toContain('value="50"');
    // A policy whose only plans are too large offers no form at all.
    const none = render({
      policies,
      previews: [
        preview(
          "preview-large",
          "policy-auto",
          titleChanges(CONSENT_LIMITS.perRunChanges.max + 1),
        ),
      ],
    });
    expect(none).toContain("No fresh plan can back a consent");
    expect(none).not.toContain("Grant automatic consent");
  });
});

describe("grant form limits", () => {
  it("match the bounds the grant schema accepts", async () => {
    const { grantAutomaticConsent } = await service();
    gates("true", "true");
    // Within bounds, validation passes and the empty database client fails next.
    const rejection = (input: Record<string, unknown>) =>
      grantAutomaticConsent(owner, input).then(
        () => "accepted",
        (error: Error) => error.name,
      );
    for (const [name, { min, max }] of Object.entries(CONSENT_LIMITS)) {
      for (const value of [min, max])
        expect(await rejection({ ...grantInput, [name]: value })).not.toBe(
          "ZodError",
        );
      for (const value of [min - 1, max + 1, min + 0.5])
        expect(await rejection({ ...grantInput, [name]: value })).toBe(
          "ZodError",
        );
    }
    expect(await rejection({ ...grantInput, confirmed: false })).toBe(
      "ZodError",
    );
  });
});
