import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoSensitiveText,
  sanitizeArtifact,
  sanitizeText,
} from "./artifact-sanitizer.mjs";
import {
  appendContract,
  appendResult,
  buildManifest,
} from "./evidence-manifest.mjs";

const LANES = [
  "preview",
  "auth",
  "publisher",
  "consumer",
  "paid-consumer",
  "payment",
];

function contract(authMode, overrides = {}) {
  const signedIn = authMode === "signed-in";
  return JSON.stringify({
    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    colorScheme: "light",
    reducedMotion: false,
    auth: {
      userId: signedIn ? "user_fixture" : null,
      organizationId: signedIn ? "org_fixture" : null,
      role: signedIn ? "org:admin" : null,
    },
    ...overrides,
  });
}

function appendFixtureContract(
  state,
  lane,
  authMode,
  raw = contract(authMode),
) {
  appendContract(
    state,
    {
      lane,
      context: `${lane}-${authMode}`,
      authMode,
      requestedWidth: "1440",
      requestedHeight: "900",
      requestedColorScheme: "light",
      requestedReducedMotion: "no-preference",
      email: authMode === "signed-in" ? "fixture@example.test" : "",
    },
    raw,
  );
}

test("artifact sanitizer redacts DOM secrets and PII into separate output", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-sanitize-"));
  const input = join(dir, "raw.snapshot.txt");
  const output = join(dir, "safe.snapshot.txt");
  writeFileSync(
    input,
    "email=user@example.com Authorization: Bearer abcdefghijkl ak_abcdef123456",
  );

  sanitizeArtifact({ inputPath: input, outputPath: output });
  const safe = readFileSync(output, "utf8");
  assert.match(safe, /\[redacted-email\]/);
  assert.match(safe, /Authorization: \[redacted\]/);
  assert.doesNotMatch(safe, /user@example\.com|abcdef123456/);
  assertNoSensitiveText(safe);
});

test("artifact sanitizer rejects symlink inputs and outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-symlink-"));
  const real = join(dir, "real.txt");
  const linked = join(dir, "linked.txt");
  writeFileSync(real, "safe");
  symlinkSync(real, linked);

  assert.throws(
    () =>
      sanitizeArtifact({ inputPath: linked, outputPath: join(dir, "out.txt") }),
    /non-symlink/,
  );
  const linkedDirectory = join(dir, "linked-directory");
  const realDirectory = join(dir, "real-directory");
  mkdirSync(realDirectory);
  symlinkSync(realDirectory, linkedDirectory);
  assert.throws(
    () =>
      sanitizeArtifact({
        inputPath: real,
        outputPath: join(linkedDirectory, "out.txt"),
      }),
    /symlink/,
  );
  assert.throws(
    () =>
      appendResult(join(linkedDirectory, "state.json"), {
        lane: "consumer",
        status: "failed",
        durationSeconds: 1,
        proof: "symlink fixture",
      }),
    /real directory|symlink/,
  );

  const existingOutput = join(dir, "existing.txt");
  writeFileSync(existingOutput, "do not replace");
  assert.throws(
    () => sanitizeArtifact({ inputPath: real, outputPath: existingOutput }),
    /new file/,
  );
});

test("manifest rejects signed-in cosplay in anonymous context", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-manifest-"));
  const state = join(dir, "state.json");
  const raw = JSON.stringify({
    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    colorScheme: "light",
    reducedMotion: false,
    auth: { userId: "user_secret", organizationId: null, role: null },
  });

  assert.throws(
    () =>
      appendContract(
        state,
        {
          lane: "consumer",
          context: "anonymous-catalogue",
          authMode: "anonymous",
          requestedWidth: "1440",
          requestedHeight: "900",
          requestedColorScheme: "light",
          requestedReducedMotion: "no-preference",
          email: "",
        },
        raw,
      ),
    /anonymous browser contract contains signed-in identity/,
  );
});

test("manifest stores identity hashes and explicit excluded lanes", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-results-"));
  const state = join(dir, "state.json");
  appendContract(
    state,
    {
      lane: "auth",
      context: "dashboard",
      authMode: "signed-in",
      requestedWidth: "1440",
      requestedHeight: "900",
      requestedColorScheme: "dark",
      requestedReducedMotion: "reduce",
      email: "private@example.com",
    },
    JSON.stringify({
      viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
      colorScheme: "dark",
      reducedMotion: true,
      auth: {
        userId: "user_private",
        organizationId: "org_private",
        role: "org:admin",
      },
    }),
  );
  appendResult(state, {
    lane: "payment",
    status: "excluded",
    durationSeconds: 0,
    proof: "provider credentials not supplied",
  });

  const serialized = readFileSync(state, "utf8");
  assert.doesNotMatch(
    serialized,
    /private@example\.com|user_private|org_private/,
  );
  assert.match(serialized, /emailSha256/);
  assert.match(serialized, /"status":"excluded"/);
});

test("residual scanner rejects unsanitized sensitive text", () => {
  assert.throws(
    () => assertNoSensitiveText("user@example.com"),
    /email address/,
  );
  assert.doesNotThrow(() =>
    assertNoSensitiveText(sanitizeText("user@example.com")),
  );
});

test("manifest rejects mismatched browser settings and sensitive proof", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-contract-"));
  const state = join(dir, "state.json");
  assert.throws(
    () =>
      appendContract(
        state,
        {
          lane: "consumer",
          context: "mismatched-viewport",
          authMode: "anonymous",
          requestedWidth: "375",
          requestedHeight: "900",
          requestedColorScheme: "light",
          requestedReducedMotion: "no-preference",
          email: "",
        },
        contract("anonymous"),
      ),
    /differs from requested evidence settings/,
  );
  assert.throws(
    () =>
      appendContract(
        state,
        {
          lane: "consumer",
          context: "anonymous-with-organization",
          authMode: "anonymous",
          requestedWidth: "1440",
          requestedHeight: "900",
          requestedColorScheme: "light",
          requestedReducedMotion: "no-preference",
          email: "",
        },
        contract("anonymous", {
          auth: {
            userId: null,
            organizationId: "org_fixture",
            role: "org:member",
          },
        }),
      ),
    /anonymous browser contract contains organization identity/,
  );
  assert.throws(
    () =>
      appendResult(state, {
        lane: "consumer",
        status: "failed",
        durationSeconds: 1,
        proof: "api_key=ak_secretfixture",
      }),
    /sensitive|secret|provider/i,
  );
});

test("manifest requires browser contracts before a lane can pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-no-contract-"));
  const state = join(dir, "state.json");
  for (const lane of LANES) {
    appendResult(state, {
      lane,
      status: lane === "consumer" ? "passed" : "excluded",
      durationSeconds: 0,
      proof: "adversarial fixture",
    });
  }
  assert.throws(
    () =>
      buildManifest({
        statePath: state,
        outputPath: join(dir, "manifest.json"),
        repoRoot: dir,
        baseUrl: "http://localhost:3000",
        runId: "missing-contract",
      }),
    /passed lane consumer lacks anonymous browser contract/,
  );
});

test("full pass binds a clean commit and downgrades dirty source", () => {
  const dir = mkdtempSync(join(tmpdir(), "zevium-e2e-exact-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "E2E Fixture"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: repo,
  });
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "test: fixture"], {
    cwd: repo,
  });

  const state = join(dir, "state.json");
  appendFixtureContract(state, "preview", "anonymous");
  appendFixtureContract(state, "auth", "anonymous");
  appendFixtureContract(state, "auth", "signed-in");
  appendFixtureContract(state, "publisher", "signed-in");
  appendFixtureContract(state, "consumer", "anonymous");
  appendFixtureContract(state, "paid-consumer", "signed-in");
  appendFixtureContract(state, "payment", "signed-in");
  for (const lane of LANES) {
    appendResult(state, {
      lane,
      status: "passed",
      durationSeconds: 1,
      proof: "asserted browser contract",
    });
  }

  const clean = buildManifest({
    statePath: state,
    outputPath: join(dir, "clean-manifest.json"),
    repoRoot: repo,
    baseUrl: "http://localhost:3000",
    runId: "clean-source",
  });
  assert.equal(clean.summary.label, "FULL E2E PASS");
  assert.equal(clean.source.worktreeClean, true);
  assert.equal(clean.browserContracts.length, 7);

  appendFixtureContract(
    state,
    "payment",
    "signed-in",
    contract("signed-in", {
      auth: {
        userId: "user_different",
        organizationId: "org_fixture",
        role: "org:admin",
      },
    }),
  );
  assert.throws(
    () =>
      buildManifest({
        statePath: state,
        outputPath: join(dir, "identity-mismatch.json"),
        repoRoot: repo,
        baseUrl: "http://localhost:3000",
        runId: "identity-mismatch",
      }),
    /inconsistent signed identity/,
  );
  appendFixtureContract(state, "payment", "signed-in");

  writeFileSync(join(repo, "untracked.txt"), "dirty\n");
  const dirty = buildManifest({
    statePath: state,
    outputPath: join(dir, "dirty-manifest.json"),
    repoRoot: repo,
    baseUrl: "http://localhost:3000",
    runId: "dirty-source",
  });
  assert.equal(dirty.summary.lanesPassed, true);
  assert.equal(dirty.summary.fullCoverage, false);
  assert.equal(dirty.summary.label, "REQUESTED E2E LANES COMPLETE");

  appendResult(state, {
    lane: "payment",
    status: "failed",
    durationSeconds: 2,
    proof: "provider assertion failed",
  });
  const failed = buildManifest({
    statePath: state,
    outputPath: join(dir, "failed-manifest.json"),
    repoRoot: repo,
    baseUrl: "http://localhost:3000",
    runId: "failed-provider",
  });
  assert.equal(failed.summary.hasFailures, true);
  assert.equal(failed.summary.label, "E2E FAILURES RECORDED");
});
