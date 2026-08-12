import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = (name: string) =>
  readFile(new URL(`../../../../.github/workflows/${name}`, import.meta.url), {
    encoding: "utf8",
  });

describe("deployment workflow security", () => {
  it("keeps standalone production workflow non-mutating", async () => {
    const [entrypoint, production] = await Promise.all([
      workflow("deploy-production.yml"),
      workflow("cloudflare-production.yml"),
    ]);

    expect(entrypoint).toContain("name: Production Broker Preflight");
    expect(entrypoint).toMatch(/permissions:\s+actions: read\s+contents: read/);
    expect(production).toContain(
      "name: Cloudflare Production Broker Preflight",
    );
    expect(production.match(/--remote-dry-run/g)).toHaveLength(2);
    expect(production.match(/versions upload --dry-run/g)).toHaveLength(1);
    expect(production).not.toMatch(/\bconvex deploy\b/);
    expect(production).not.toMatch(/versions deploy/);
    expect(production).not.toMatch(/versions upload \\\n(?!\s+--dry-run)/);
    expect(production).not.toMatch(/CLOUDFLARE_API_TOKEN|BROKER_ENV_FILE/);
    expect(production).not.toMatch(/\bcurl\b|smoke/i);
  });

  it("uses exact publisher for preview mutation", async () => {
    const [preview, caller] = await Promise.all([
      workflow("cloudflare-preview.yml"),
      workflow("preview.yml"),
    ]);

    expect(preview).toMatch(/permissions:\s+actions: read\s+contents: read/);
    expect(caller).toMatch(
      /web-preview:[\s\S]*?permissions:\s+actions: read\s+contents: read\s+id-token: write/,
    );
    expect(preview.match(/versions upload --dry-run/g)).toHaveLength(1);
    expect(preview).toContain("apps/deploy-broker/scripts/publish.ts");
    expect(preview).not.toMatch(/versions deploy|wrangler secret put/);
    expect(preview).not.toContain("--secrets-file");
    expect(preview).not.toContain("CLOUDFLARE_API_BASE_URL=");
    expect(preview).toContain(
      "GATEWAY_INTERNAL_SECRET: ${{ secrets.GATEWAY_PREVIEW_INTERNAL_SECRET }}",
    );
  });

  it("keeps remote dry-run ahead of all Durable Object writes", async () => {
    const broker = await readFile(
      new URL("../../src/index.ts", import.meta.url),
      "utf8",
    );
    const dryRunExit = broker.indexOf("if (dryRun)");
    const rateWrite = broker.indexOf("await consumeRegistrationRate");

    expect(dryRunExit).toBeGreaterThan(0);
    expect(rateWrite).toBeGreaterThan(dryRunExit);
    expect(broker).toContain("cacheJwks: !dryRun");
  });

  it("rejects stale source CI before executing candidate code", async () => {
    const production = await workflow("cloudflare-production.yml");
    const guard = production.indexOf(
      "Reject stale or mismatched source run before checkout",
    );
    const checkout = production.indexOf("actions/checkout@");

    expect(guard).toBeGreaterThan(0);
    expect(checkout).toBeGreaterThan(guard);
    expect(production).toContain(
      'test "$(gh api "repos/$GITHUB_REPOSITORY/commits/develop" --jq .sha)" = "$RELEASE_SHA"',
    );
    expect(production).toContain('run.path!==".github/workflows/ci.yml"');
    expect(production).toContain('String(run.repository?.id)!=="1044451612"');
  });

  it("pins every third-party action to a full commit", async () => {
    const sources = await Promise.all([
      workflow("cloudflare-preview.yml"),
      workflow("cloudflare-production.yml"),
      workflow("deploy-production.yml"),
    ]);
    const uses = sources.flatMap((source) =>
      [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(
        (match) => match[1] ?? "",
      ),
    );

    for (const action of uses) {
      if (action.startsWith("./")) continue;
      expect(action, action).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }
  });
});
