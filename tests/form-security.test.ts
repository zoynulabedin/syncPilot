import { afterEach, describe, expect, it, vi } from "vitest";
import { pageLoader, readActionForm } from "../app/components/actions.server";
import { DomainError } from "../app/domain/errors";

afterEach(() => vi.unstubAllEnvs());
describe("what a page's loader refuses", () => {
  const thrownBy = (error: unknown) =>
    pageLoader(async () => {
      throw error;
    })().catch((thrown: unknown) => thrown);

  it("becomes a response carrying the service's own words, kept by nothing", async () => {
    const answer = (await thrownBy(
      new DomainError("MEMBERSHIP_REQUIRED", "Ask an owner for access.", 403),
    )) as Response;
    expect(answer).toBeInstanceOf(Response);
    expect(answer.status).toBe(403);
    expect(await answer.text()).toBe("Ask an owner for access.");
    expect(answer.headers.get("Cache-Control")).toBe("no-store");
  });

  it("stays an error when it is a server fault, so its words stay out of the page", async () => {
    const fault = new DomainError("BROKEN", "Internal detail.", 500);
    expect(await thrownBy(fault)).toBe(fault);
    const bug = new TypeError("Internal detail.");
    expect(await thrownBy(bug)).toBe(bug);
  });

  it("leaves a response from further in, and a page's data, as they are", async () => {
    const redirect = new Response(null, { status: 302 });
    expect(await thrownBy(redirect)).toBe(redirect);
    await expect(pageLoader(async () => ({ page: 1 }))()).resolves.toEqual({
      page: 1,
    });
  });
});
describe("authenticated action form boundaries", () => {
  it("rejects cross-origin submissions and oversized bodies", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://sync.example.invalid");
    const request = (body: string, origin: string) =>
      new Request("https://sync.example.invalid/app/rules", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: origin,
        },
        body,
      });
    await expect(
      readActionForm(request("intent=save", "https://attacker.invalid")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readActionForm(
        request("field=" + "a".repeat(65536), "https://sync.example.invalid"),
      ),
    ).rejects.toMatchObject({ status: 413 });
    const form = await readActionForm(
      request(
        "title=%E7%94%A2%E5%93%81&intent=save",
        "https://sync.example.invalid",
      ),
    );
    expect(form.get("title")).toBe("產品");
  });
  it("rejects unimplemented body encodings", async () => {
    await expect(
      readActionForm(
        new Request("https://sync.example.invalid/app/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});
