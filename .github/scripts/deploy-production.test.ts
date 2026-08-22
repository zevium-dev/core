import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  ".github/workflows/deploy-production.yml",
  "utf8",
);

describe("production deployment workflow", () => {
  it("deploys one green develop commit behind production approval", () => {
    expect(workflow).toContain("workflows: [Continuous Integration]");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(workflow).toContain("group: production-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("git ls-remote origin refs/heads/develop");
  });

  it("uses supported provider commands in dependency order", () => {
    const convex = workflow.indexOf("pnpm exec convex deploy --message");
    const gateway = workflow.indexOf(
      "@zevium/gateway exec wrangler versions upload",
    );
    const web = workflow.indexOf("--config dist/server/wrangler.json");
    const smoke = workflow.indexOf("Verify production");
    expect(Math.min(convex, gateway, web, smoke)).toBeGreaterThan(0);
    expect(convex).toBeLessThan(gateway);
    expect(gateway).toBeLessThan(web);
    expect(web).toBeLessThan(smoke);
    expect(workflow).toContain("convex deploy --dry-run");
    expect(workflow).not.toMatch(/convex deploy[^\n]*--yes/);
    expect(workflow).toContain('--tag "production-$RELEASE_SHA"');
    expect(workflow.match(/wrangler versions deploy/g)).toHaveLength(2);
    expect(workflow).toContain(
      '--version-tag "production-$RELEASE_SHA@100%" --yes',
    );
  });

  it("has no self-hosted release policy or paid probe dependency", () => {
    expect(workflow).not.toMatch(
      /RELEASE_REFEREE|release-attestation|release-state|with-clerk-release-key|RELEASE_PROBE/,
    );
    expect(workflow).toContain("$PRODUCTION_GATEWAY_URL/health");
    expect(workflow).toContain("$PRODUCTION_WEB_URL/catalogue");
  });
});
