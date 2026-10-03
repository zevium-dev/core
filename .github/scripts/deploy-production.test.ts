import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
    expect(workflow).toContain('--tag "$RELEASE_TAG"');
    expect(workflow.match(/wrangler versions deploy/g)).toHaveLength(2);
    expect(workflow).toContain('--version-tag "$RELEASE_TAG@100%" --yes');
  });

  it("keeps upload tags unique across workflow retries and deploys the same tag", () => {
    const document = parse(workflow);
    expect(document.jobs.deploy.env.RELEASE_TAG).toBe(
      "production-${{ github.event.workflow_run.head_sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow.match(/--tag "\$RELEASE_TAG"/g)).toHaveLength(2);
    expect(workflow.match(/--version-tag "\$RELEASE_TAG@100%"/g)).toHaveLength(
      2,
    );
  });

  it("has no self-hosted release policy or paid probe dependency", () => {
    expect(workflow).not.toMatch(
      /RELEASE_REFEREE|release-attestation|release-state|with-clerk-release-key|RELEASE_PROBE/,
    );
    expect(workflow).toContain("$PRODUCTION_GATEWAY_URL/health");
    expect(workflow).toContain("$PRODUCTION_WEB_URL/catalogue");
  });

  it("waits for both promoted releases instead of accepting a stale 200", () => {
    expect(workflow).toContain('expected="${3:-}"');
    expect(workflow).toContain(
      '{ test -z "$expected" || grep --fixed-strings --quiet "$expected" "$output"; }',
    );
    expect(workflow).toContain(
      '"name=\\"zevium-release\\" content=\\"$RELEASE_SHA\\""',
    );
    expect(workflow).toContain('"\\"release\\":\\"$RELEASE_SHA\\""');
  });

  it("configures matching registration secrets without logging them", () => {
    const root = mkdtempSync(join(tmpdir(), "zevium-production-registry-"));
    try {
      const sha = "a".repeat(40);
      const git = join(root, "git");
      writeFileSync(
        git,
        '#!/bin/sh\nprintf "%s\\trefs/heads/develop\\n" "$REMOTE_SHA"\n',
      );
      chmodSync(git, 0o755);
      const pnpm = join(root, "pnpm");
      writeFileSync(
        pnpm,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args: process.argv.slice(2), value: fs.readFileSync(0, "utf8") }) + "\\n");
`,
      );
      chmodSync(pnpm, 0o755);
      const document = parse(workflow);
      const steps = document.jobs.deploy.steps;
      const configure = steps.find(
        (step: { name?: string }) => step.name === "Configure registry runtime",
      ).run;
      const cleanup = steps.find(
        (step: { name?: string }) => step.name === "Remove runtime secret file",
      );
      const ring = JSON.stringify({
        current: "fixture-v1",
        keys: { "fixture-v1": "42".repeat(32) },
      });
      const secret = "fixture-projection-secret-for-deploy-tests";
      const credentialRing = JSON.stringify({
        current: "fixture-v1",
        keys: { "fixture-v1": Buffer.alloc(32, 0x42).toString("base64") },
      });
      const calls = join(root, "calls.jsonl");
      const secretFile = join(root, "zevium-web-runtime-secrets.json");
      const env = {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        RELEASE_SHA: sha,
        REMOTE_SHA: sha,
        CALLS: calls,
        GATEWAY_REGISTRY_TRANSPORT_KEYRING: ring,
        REGISTRY_KEY_PROJECTION_HMAC_SECRET: secret,
        UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS: credentialRing,
      };
      const run = spawnSync("bash", ["-e", "-o", "pipefail", "-c", configure], {
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout + run.stderr).not.toContain(secret);
      expect(run.stdout + run.stderr).not.toContain(ring);
      expect(
        readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          args: [
            "exec",
            "convex",
            "env",
            "set",
            "GATEWAY_REGISTRY_TRANSPORT_KEYRING",
          ],
          value: ring,
        },
        {
          args: [
            "exec",
            "convex",
            "env",
            "set",
            "REGISTRY_KEY_PROJECTION_HMAC_SECRET",
          ],
          value: secret,
        },
        {
          args: [
            "exec",
            "convex",
            "env",
            "set",
            "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
          ],
          value: credentialRing,
        },
      ]);
      expect(JSON.parse(readFileSync(secretFile, "utf8"))).toEqual({
        REGISTRY_KEY_PROJECTION_HMAC_SECRET: secret,
      });
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(workflow).toContain(
        '--secrets-file "$RUNNER_TEMP/zevium-web-runtime-secrets.json"',
      );
      expect(cleanup.if).toBe("always()");
      const cleaned = spawnSync("bash", ["-e", "-c", cleanup.run], {
        env,
        encoding: "utf8",
      });
      expect(cleaned.status).toBe(0);
      expect(() => statSync(secretFile)).toThrow("ENOENT");
      rmSync(calls);
      const stale = spawnSync(
        "bash",
        ["-e", "-o", "pipefail", "-c", configure],
        { env: { ...env, REMOTE_SHA: "b".repeat(40) }, encoding: "utf8" },
      );
      expect(stale.status).not.toBe(0);
      expect(() => statSync(calls)).toThrow("ENOENT");
      expect(() => statSync(secretFile)).toThrow("ENOENT");
      expect(
        steps.findIndex(
          (step: { name?: string }) => step.name === "Deploy Convex",
        ),
      ).toBeLessThan(
        steps.findIndex(
          (step: { name?: string }) =>
            step.name === "Configure registry runtime",
        ),
      );
      expect(
        steps.findIndex(
          (step: { name?: string }) =>
            step.name === "Configure registry runtime",
        ),
      ).toBeLessThan(
        steps.findIndex(
          (step: { name?: string }) => step.name === "Deploy web",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed encryption keys and weak registration secrets before deployment", () => {
    const document = parse(workflow);
    const identity = document.jobs.deploy.steps.find(
      (step: { name?: string }) =>
        step.name === "Verify approved release identity",
    ).run;
    const validate = identity.slice(identity.indexOf("node --import tsx"));
    const ring = JSON.stringify({
      current: "fixture-v1",
      keys: { "fixture-v1": "42".repeat(32) },
    });
    const credentialRing = JSON.stringify({
      current: "fixture-v1",
      keys: { "fixture-v1": Buffer.alloc(32, 0x42).toString("base64") },
    });
    const run = (
      transport: string,
      projection: string,
      credential = credentialRing,
    ) =>
      spawnSync("bash", ["-e", "-c", validate], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          GATEWAY_REGISTRY_TRANSPORT_KEYRING: transport,
          REGISTRY_KEY_PROJECTION_HMAC_SECRET: projection,
          UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS: credential,
        },
      }).status;
    expect(run(ring, "fixture-projection-secret-for-deploy-tests")).toBe(0);
    expect(run("{}", "fixture-projection-secret-for-deploy-tests")).not.toBe(0);
    expect(
      run(
        JSON.stringify({
          current: "missing",
          keys: { "fixture-v1": "42".repeat(32) },
        }),
        "fixture-projection-secret-for-deploy-tests",
      ),
    ).not.toBe(0);
    expect(run(ring, "weak")).not.toBe(0);
    expect(
      run(
        ring,
        "fixture-projection-secret-for-deploy-tests",
        JSON.stringify({
          current: "fixture-v1",
          keys: { "fixture-v1": "legacy-unbound-material" },
        }),
      ),
    ).not.toBe(0);
  });

  it("accepts changed catalogue copy but rejects a broken catalogue surface", () => {
    const root = mkdtempSync(join(tmpdir(), "zevium-production-smoke-"));
    try {
      const curl = join(root, "curl");
      writeFileSync(
        curl,
        `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */health)
    if test "\${STALE_GATEWAY_HEALTH:-}" = 1 && ! test -f "$HEALTH_ATTEMPT_MARKER"; then
      touch "$HEALTH_ATTEMPT_MARKER"
      printf '{"ok":true,"service":"zevium-gateway","release":"previous-release","contract":1}' > "$output"
      printf 200
      exit 0
    fi
    printf '{"ok":true,"service":"zevium-gateway","release":"%s","contract":1}' "$RELEASE_SHA" > "$output"
    printf 200 ;;
  */catalogue)
    cat "$CATALOGUE_FIXTURE" > "$output"
    printf 200 ;;
  */release-contract-missing)
    printf '{"error":"not found"}' > "$output"
    printf 404 ;;
  *)
    printf '<meta name="zevium-release" content="%s">' "$RELEASE_SHA" > "$output"
    printf 200 ;;
esac
`,
      );
      chmodSync(curl, 0o755);
      const sleep = join(root, "sleep");
      writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
      chmodSync(sleep, 0o755);
      const catalogue = join(root, "catalogue.html");
      const healthMarker = join(root, "health-attempt");
      const document = parse(workflow);
      const smoke = document.jobs.deploy.steps.find(
        (step: { name?: string }) => step.name === "Verify production",
      ).run;
      const run = (html: string, staleGateway = false) => {
        writeFileSync(catalogue, html);
        rmSync(healthMarker, { force: true });
        return spawnSync("bash", ["-e", "-c", smoke], {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            RELEASE_SHA: "0".repeat(40),
            PRODUCTION_GATEWAY_URL: "https://gateway.example.invalid",
            PRODUCTION_WEB_URL: "https://web.example.invalid",
            CATALOGUE_FIXTURE: catalogue,
            STALE_GATEWAY_HEALTH: staleGateway ? "1" : "0",
            HEALTH_ATTEMPT_MARKER: healthMarker,
          },
        }).status;
      };
      const title = "<title>Catalogue · Zevium</title>";
      const search = '<input id="catalogue-search">';
      expect(run(`${title}${search}<p>New catalogue description</p>`)).toBe(0);
      expect(run(`${title}${search}`, true)).toBe(0);
      expect(run(`${title}<p>Missing search form</p>`)).toBe(1);
      expect(run(`${title}${search}<p>Something went wrong</p>`)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
