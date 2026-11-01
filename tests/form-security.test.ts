import { afterEach, describe, expect, it, vi } from "vitest";
import { readActionForm } from "../app/components/actions.server";

afterEach(() => vi.unstubAllEnvs());
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
