import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The default client stays empty, so a real service call fails on any lookup
// the test did not stub.
const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  auth: vi.fn(),
  buildPreview: vi.fn(),
}));
vi.mock("../app/db.server", () => ({ default: mocks.prisma }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));
vi.mock("../app/services/sync-engine.server", () => ({
  buildPreview: mocks.buildPreview,
}));
import type { Actor } from "../app/services/authorization.server";
import Rules, { action, loader } from "../app/routes/app.rules";

const shop = "rules-source.myshopify.com";
const partner = "rules-target.myshopify.com";
const owner: Actor = { shop, userId: "101", role: "OWNER" };
// Shopify staff; the workspace membership decides VIEWER or OPERATOR.
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

const url = "https://sync.example.invalid/app/rules";
const route = {
  url: new URL(url),
  pattern: "/app/rules",
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

const policy = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace-1",
  sourceShopDomain: shop,
  targetShopDomain: partner,
  fields: ["title"],
  syncInventory: false,
  inventoryAuthority: null,
  inventoryMode: "DISABLED",
  buffer: 0,
  reconciliationMinutes: 360,
  enabled: false,
  status: "DRAFT",
  updatedAt: new Date("2026-11-01T00:00:00Z"),
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...overrides,
});
const titleChange = {
  kind: "PRODUCT",
  field: "title",
  sourceId: "gid://shopify/Product/1",
  targetId: "gid://shopify/Product/1001",
  before: "Old title",
  after: "New title",
};

// A verified pair in which the signed-in staff account holds `role`.
const workspace = (role: "VIEWER" | "OPERATOR") => {
  const stored = policy("policy-1");
  const db = {
    shopConnection: {
      upsert: vi.fn().mockResolvedValue({
        shopDomain: shop,
        workspaceId: "workspace-1",
        status: "CONNECTED",
        uninstalledAt: null,
      }),
      findUnique: vi.fn().mockResolvedValue({
        shopDomain: shop,
        workspaceId: "workspace-1",
        status: "CONNECTED",
        uninstalledAt: null,
      }),
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
      findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE", role }),
    },
    storePair: {
      findFirst: vi.fn().mockResolvedValue({
        id: "pair-1",
        sourceShop: shop,
        targetShop: partner,
        status: "VERIFIED",
      }),
    },
    syncPolicy: {
      findFirst: vi.fn().mockResolvedValue(stored),
      findMany: vi.fn().mockResolvedValue([stored]),
      create: vi.fn(),
      update: vi.fn(),
    },
    syncPreview: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "preview-1" }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    syncJob: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((run: (tx: unknown) => unknown) => run(mocks.prisma)),
  };
  Object.assign(mocks.prisma, db);
  return db;
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];
});

describe("sync rules loader", () => {
  it("lets operators prepare dry runs while management stays owner-only", async () => {
    for (const [actor, role, canManage, canOperate] of [
      [owner, "VIEWER", true, true],
      [staff, "OPERATOR", false, true],
      [staff, "VIEWER", false, false],
    ] as const) {
      workspace(role);
      signIn(actor);
      await expect(loader(get())).resolves.toMatchObject({
        canManage,
        canOperate,
        policies: [{ id: "policy-1" }],
      });
    }
  });
});

describe("sync rules actions", () => {
  it("creates a dry-run plan for an operator without writing anything else", async () => {
    const db = workspace("OPERATOR");
    mocks.buildPreview.mockResolvedValue({
      sourceHash: "source-hash",
      targetHash: "target-hash",
      changes: [titleChange],
    });
    signIn(staff);
    await expect(
      action(post({ intent: "preview", id: "policy-1" })),
    ).resolves.toEqual({ success: expect.stringContaining("Dry-run plan") });
    expect(mocks.buildPreview).toHaveBeenCalledWith("policy-1");
    expect(db.syncPreview.create).toHaveBeenCalledTimes(1);
    const plan = db.syncPreview.create.mock.calls[0][0].data;
    expect(plan).toMatchObject({
      workspaceId: "workspace-1",
      policyId: "policy-1",
      createdBy: `${shop}:202`,
      changes: [titleChange],
    });
    // The plan stays pending: an operator's dry run carries no approval.
    expect(plan).not.toHaveProperty("status");
    expect(plan).not.toHaveProperty("approvedBy");
    expect(db.auditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "SYNC_PREVIEWED",
      actor: `${shop}:202`,
    });
    for (const write of [
      db.syncPolicy.create,
      db.syncPolicy.update,
      db.syncPreview.update,
      db.syncPreview.updateMany,
      db.syncJob.create,
      db.syncJob.createMany,
      db.syncJob.updateMany,
    ])
      expect(write).not.toHaveBeenCalled();
  });

  it("refuses dry runs from viewer staff before comparing stores", async () => {
    const db = workspace("VIEWER");
    signIn(staff);
    await expect(
      action(post({ intent: "preview", id: "policy-1" })),
    ).resolves.toMatchObject({
      data: { error: expect.stringContaining("operator access") },
      init: { status: 403 },
    });
    expect(mocks.buildPreview).not.toHaveBeenCalled();
    expect(db.syncPreview.create).not.toHaveBeenCalled();
  });

  it("keeps save, approve, pause and activate owner-only for operators", async () => {
    const db = workspace("OPERATOR");
    signIn(staff);
    for (const fields of [
      {
        intent: "save",
        sourceShop: shop,
        targetShop: partner,
        fields: "title",
        inventoryMode: "DISABLED",
        buffer: "0",
        reconciliationMinutes: "360",
      },
      { intent: "approve", id: "preview-1", approvalConfirmed: "on" },
      { intent: "pause", id: "policy-1" },
      { intent: "activate", id: "policy-1" },
    ] as Record<string, string>[])
      await expect(action(post(fields))).resolves.toMatchObject({
        data: { error: "A verified store owner must approve this operation." },
        init: { status: 403 },
      });
    // Owner authority is checked before any lookup, so nothing was read either.
    expect(db.shopConnection.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mocks.buildPreview).not.toHaveBeenCalled();
  });
});

type PageData = Awaited<ReturnType<typeof loader>>;
const render = (data: Partial<Record<keyof PageData, unknown>>) => {
  const Stub = createRoutesStub([
    { id: "page", path: "/app/rules", Component: Rules },
  ]);
  const page = {
    policies: [
      policy("policy-active", { enabled: true, status: "ACTIVE" }),
      policy("policy-draft"),
    ],
    previews: [
      {
        id: "preview-1",
        workspaceId: "workspace-1",
        policyId: "policy-active",
        status: "PENDING",
        changes: [titleChange],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    ],
    connections: [{ shopDomain: shop }, { shopDomain: partner }],
    canManage: true,
    canOperate: true,
    writesEnabled: true,
    inventoryWritesEnabled: true,
    editingId: null,
    observedNow: Date.now(),
    ...data,
  };
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/app/rules"],
      hydrationData: { loaderData: { page } },
    }),
  );
};
// Every submit button for an intent, and whether each one is disabled.
const buttons = (html: string, intent: string) =>
  [...html.matchAll(/<button[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes(`value="${intent}"`))
    .map((tag) => (/\sdisabled=""/.test(tag) ? "disabled" : "enabled"));
const approval = (html: string) =>
  html.match(/<input[^>]*name="approvalConfirmed"[^>]*>/)?.[0] ?? "";

describe("sync rules page", () => {
  it("enables only the dry run for operators", () => {
    const html = render({ canManage: false, canOperate: true });
    expect(buttons(html, "preview")).toEqual(["enabled", "enabled"]);
    for (const intent of ["pause", "activate", "save", "approve"])
      expect(buttons(html, intent)).toEqual(["disabled"]);
    expect(approval(html)).toContain('disabled=""');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("You have operator access");
    expect(html).not.toContain("You have read-only access");
  });

  it("disables every control for viewers", () => {
    const html = render({ canManage: false, canOperate: false });
    expect(buttons(html, "preview")).toEqual(["disabled", "disabled"]);
    for (const intent of ["pause", "activate", "save", "approve"])
      expect(buttons(html, intent)).toEqual(["disabled"]);
    expect(html).toContain("You have read-only access");
    expect(html).not.toContain("You have operator access");
  });

  it("keeps every control available to owners", () => {
    const html = render({});
    expect(buttons(html, "preview")).toEqual(["enabled", "enabled"]);
    for (const intent of ["pause", "activate", "save", "approve"])
      expect(buttons(html, intent)).toEqual(["enabled"]);
    expect(approval(html)).not.toContain("disabled");
    expect(html).not.toContain("You have read-only access");
    expect(html).not.toContain("You have operator access");
  });

  it("still lets operators dry-run while the write gate is closed", () => {
    const html = render({
      canManage: false,
      canOperate: true,
      writesEnabled: false,
      inventoryWritesEnabled: false,
    });
    expect(buttons(html, "preview")).toEqual(["enabled", "enabled"]);
    expect(buttons(html, "activate")).toEqual(["disabled"]);
    expect(buttons(html, "approve")).toEqual(["disabled"]);
  });
});
