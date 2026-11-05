import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  workspace: vi.fn(),
  products: vi.fn(),
  productCount: vi.fn(),
  variants: vi.fn(),
  latest: vi.fn(),
  inventory: vi.fn(),
  inventoryCount: vi.fn(),
  locations: vi.fn(),
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));
vi.mock("../app/services/control-plane.server", () => ({
  getWorkspace: mocks.workspace,
}));
vi.mock("../app/services/database-clock.server", () => ({
  databaseNow: async () => new Date(),
}));
vi.mock("../app/db.server", () => ({
  default: {
    productSnapshot: { findMany: mocks.products, count: mocks.productCount },
    variantSnapshot: { findMany: mocks.variants },
    catalogSnapshot: { findFirst: mocks.latest },
    inventorySnapshot: {
      findMany: mocks.inventory,
      count: mocks.inventoryCount,
    },
    locationSnapshot: { findMany: mocks.locations },
  },
}));
import { loader as productsLoader } from "../app/routes/app.products";
import { loader as inventoryLoader } from "../app/routes/app.inventory";

const source = "source-context.myshopify.com",
  target = "target-context.myshopify.com";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    session: {
      shop: source,
      onlineAccessInfo: { associated_user: { id: 101, account_owner: true } },
    },
  });
  mocks.workspace.mockResolvedValue({
    connections: [{ shopDomain: source }, { shopDomain: target }],
  });
  for (const mock of [
    mocks.products,
    mocks.variants,
    mocks.inventory,
    mocks.locations,
  ])
    mock.mockResolvedValue([]);
  mocks.productCount.mockResolvedValue(0);
  mocks.inventoryCount.mockResolvedValue(0);
  mocks.latest.mockResolvedValue(null);
});
const args = (query: string): LoaderFunctionArgs => ({
  request: new Request(`https://sync.example.invalid/app/products?${query}`),
  url: new URL(`https://sync.example.invalid/app/products?${query}`),
  pattern: "/app/products",
  params: {},
  context: {},
});
for (const [name, loader, count] of [
  ["products", productsLoader, mocks.productCount],
  ["inventory", inventoryLoader, mocks.inventoryCount],
] as const) {
  describe(`${name} store selection preserves Shopify installation identity`, () => {
    it("selects the authorized paired store without changing the actor's installation", async () => {
      await loader(args(`shop=${source}&store=${target}`));
      expect(mocks.workspace).toHaveBeenCalledWith({
        shop: source,
        userId: "101",
        role: "OWNER",
      });
      expect(count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ shopDomain: target }),
        }),
      );
    });
    it("does not treat Shopify's reserved shop parameter as the catalog filter", async () => {
      await loader(args(`shop=${target}`));
      expect(count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ shopDomain: source }),
        }),
      );
    });
    it("rejects a third store before catalog data access", async () => {
      await expect(
        loader(args(`shop=${source}&store=third-context.myshopify.com`)),
      ).rejects.toMatchObject({ status: 403 });
      expect(count).not.toHaveBeenCalled();
    });
  });
}
