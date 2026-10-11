import { describe, it, expect } from "vitest";
import { sealOneTimeExecutionKey } from "./key-projection";
describe("key broker projection", () => {
  it("never puts raw one-time key material in canonical projection", async () => {
    const sealed = await sealOneTimeExecutionKey({
      keyId: "ck_1",
      secret: "one-time-secret-value",
      clerkOrgId: "org_test",
      ownerUserId: "user_1",
      subjectUserId: "user_1",
      budgetId: "budget_random_1",
      budgetRevision: 1,
      scopes: ["gateway:execute"],
    });
    expect(JSON.stringify(sealed.provision)).not.toContain(
      "one-time-secret-value",
    );
    expect(sealed.provision.secretSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sealed.provision.budgetId).toBe("budget_random_1");
  });
});
