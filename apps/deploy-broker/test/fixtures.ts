import type { GitHubOidcClaims } from "../src/jwt";

export const TEST_PRIVATE_JWK: JsonWebKey = {
  kty: "RSA",
  n: "lD2Oqv7c2FcGhwkGHLPL0xgvIKwVPkY4PWxLFTdsPKXCFmxjsrT2k2_cHey8JiCoEzOE8wFCG0Pp0ANO3_XwPkcLfTF7qGM9TdXQ5qVk34DyytpChmivWFZ36H1rIhWjLwFHwtGYBy69f8fe6gQ4-fFJfU7AGOPYxmS0cYg2UQZJ3IGRxflEnXSqkS8NEzKLCLfHi_QA-0eHZ9PMqa3Z6LEIaD6WEhBpX0wzcIOvLqP7CIyZ7C6EcgHdzNDenlw1pSkvhHgSAz_T4BfDtNnyltfgUrUhXybPJX4FqUK6Lr7r--HCLD9rEZnNqsuLGmnOMdT_uavkIA8x3XOEc-P0jQ",
  e: "AQAB",
  d: "LfWJymT61k3g1bPMA9EQc9FvJwuDCIwfupddDeZhdcoUSvxuyoSFX_-RuGthh9afFVjnMqnks2xSTK4B4bivs7c2Dintwy6FXqDYQ_HqPMsPOyoA7wf8uQAR6_Aaa3ZW4eddNr7hifSJRtkSOO53NbKDjMiCERVu609kjEBlSqgWJyLurRWMcet9eRLQS68WvU6oOPHr_128EEHRL57mWM1oT3FGU-1yDzTQHYVcmWIABWAfzYHXnEEho3T8J8CBkkwCBLLEidmftZ2R_77glQFv5Fd9j8tF-Vk2cbeUJG-2l5XvgVyX4ZwsrNHDoSbOssttsUUZXeHinZaZI35xNw",
  p: "xXewjLuLeNbSNyMK2BiMXjO6RkqDIzv1kNj2jggmB_DWG5ciZBHE40toMgf8WOysCAqr5PUj7Vhgg2UF7vXC3rlJoT_k-cgWSv0MiOW6NN-ZpNATwd9nek7zrG8A8nhX2vLq8VT-f6o4k6AE0NEbNembALFm2DHnTZjFNgZVN48",
  q: "wC5mF2D_COIYfuA-byTgl87hgKFz0-jwcE5E0x17X1fPBGrVc-y7J3k4-lElAPaZE8bcYHQDNjqP3DwAiejVsu_cJmIyyD4bw0tjYTIBWoXFgBw5ar8ko7IlE9mgO6OUu4gyyAFD0HhbUgGSvk5-EJeTYE82h8namdgfRPIe5CM",
  dp: "YLB8mEx0vJSjli_obWuHv9CgUy7FC4mecnBqOZ2v0Y-RpyzXwBwbRhh0SpsyavBoQ__Fr3SBRQRTLcNXpmxcIOalMPmySsQ4djt12cpy5NTfzJ2-Lt4PMwpZsoMf-ZoHmsP7WnP9sdFNpqth8EWTh1B9f1dePlohIhO97Pgo3e0",
  dq: "F5ja4j3_sqiIV3PTVrRRe3Jkj_XDEh8E_tUtcDqrfl56xdEUWoKTzFn_HAVApOiijSIaxyEXj94K8gDQFB7ptmnrPy9JivrNT-J-1l1cey_3uy48ApZruknScaiEGy6PwaMMkTBOkldk5yHYUdOzePgTmXzAdlXbqI438LBGCL8",
  qi: "DV8V6-a-SfU7PKjI9pXLrLlz4InJ8fpmcOlAvgus4nhg9w-liKCUMnVXPqi1MdJWsPreBumcCFlp-OmqvYtQHgCBZ7dTqelmZaE302QYI2oVForcxs5zI9FjOkSBYDa2ksNzFHYjF53azPwzic5SQ5nul3MiVZstqA1VKtYCMlk",
};

export const TEST_PUBLIC_JWK: JsonWebKey & { kid: string } = {
  alg: "RS256",
  e: "AQAB",
  kid: "test-key-1",
  kty: "RSA",
  n: "lD2Oqv7c2FcGhwkGHLPL0xgvIKwVPkY4PWxLFTdsPKXCFmxjsrT2k2_cHey8JiCoEzOE8wFCG0Pp0ANO3_XwPkcLfTF7qGM9TdXQ5qVk34DyytpChmivWFZ36H1rIhWjLwFHwtGYBy69f8fe6gQ4-fFJfU7AGOPYxmS0cYg2UQZJ3IGRxflEnXSqkS8NEzKLCLfHi_QA-0eHZ9PMqa3Z6LEIaD6WEhBpX0wzcIOvLqP7CIyZ7C6EcgHdzNDenlw1pSkvhHgSAz_T4BfDtNnyltfgUrUhXybPJX4FqUK6Lr7r--HCLD9rEZnNqsuLGmnOMdT_uavkIA8x3XOEc-P0jQ",
  use: "sig",
};

export const HEAD_SHA = "a".repeat(40);
export const MERGE_SHA = "b".repeat(40);
export const PRODUCTION_SHA = "c".repeat(40);
export const TEST_MODULE_ARTIFACTS = {
  mainModule: "index.js",
  modules: [
    {
      contentType: "application/javascript+module",
      name: "index.js",
      sha256:
        "beb20a4a89bf69cff85440d6746fcbfeebf92d181926072acf0b153cd1528f89",
      size: 56,
    },
  ],
};
export const TEST_WEB_SECRET_DIGESTS = [
  { name: "CLERK_SECRET_KEY", sha256: "e".repeat(64) },
];
const TEST_ASSET_BYTES = new TextEncoder().encode("bound static asset");
const TEST_ASSET_BASE64 = btoa(String.fromCharCode(...TEST_ASSET_BYTES));
export const TEST_ASSET_SHA256 =
  "51c7388b9d9443c3d4d298797dbc948fb3d54b84adee194ae0e0ff9d7106c901";
export const TEST_STATIC_ASSETS = {
  staticAssets: [
    {
      cloudflareHash: "b".repeat(32),
      contentType: "text/javascript; charset=utf-8",
      path: "/copy.js",
      sha256: TEST_ASSET_SHA256,
      size: TEST_ASSET_BYTES.byteLength,
    },
  ],
};
export { TEST_ASSET_BASE64, TEST_ASSET_BYTES };
export const PREVIEW_SECRET_DIGESTS = [
  {
    name: "CLERK_SECRET_KEY",
    sha256: "be92b5c31a7e6d008251c0950e6b944d3d10442931b97a1e84d6cf8289b1701f",
  },
  {
    name: "GATEWAY_INTERNAL_SECRET",
    sha256: "b704d663a3e9371f725b507cce561602698413286e0bd72fc9944d18c0abefa3",
  },
];
export const TEST_CLERK_SECRET = "redacted-test-secret";
export const TEST_GATEWAY_SECRET = "redacted-test-gateway-secret";

function base64Url(value: Uint8Array | string): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function previewClaims(
  audience: string,
  overrides: Partial<GitHubOidcClaims> = {},
): GitHubOidcClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    actor: "tnfssc",
    actor_id: "29162020",
    aud: audience,
    base_ref: "develop",
    environment: "preview",
    event_name: "pull_request",
    exp: now + 300,
    head_ref: "broker-branch",
    iat: now,
    iss: "https://token.actions.githubusercontent.com",
    job_workflow_ref:
      "zevium-dev/core/.github/workflows/cloudflare-preview.yml@refs/pull/123/merge",
    job_workflow_sha: MERGE_SHA,
    jti: `test-jti-${crypto.randomUUID()}`,
    nbf: now - 5,
    ref: "refs/pull/123/merge",
    repository: "zevium-dev/core",
    repository_id: "1044451612",
    repository_owner: "zevium-dev",
    repository_owner_id: "228443220",
    repository_visibility: "public",
    run_attempt: "1",
    run_id: "9001",
    sha: MERGE_SHA,
    sub: "repo:zevium-dev/core:environment:preview",
    workflow_ref:
      "zevium-dev/core/.github/workflows/preview.yml@refs/pull/123/merge",
    workflow_sha: MERGE_SHA,
    ...overrides,
  };
}

export function productionClaims(
  audience: string,
  overrides: Partial<GitHubOidcClaims> = {},
): GitHubOidcClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    actor: "tnfssc",
    actor_id: "29162020",
    aud: audience,
    base_ref: "",
    environment: "production",
    event_name: "workflow_run",
    exp: now + 300,
    head_ref: "",
    iat: now,
    iss: "https://token.actions.githubusercontent.com",
    job_workflow_ref:
      "zevium-dev/core/.github/workflows/cloudflare-production.yml@refs/heads/develop",
    job_workflow_sha: PRODUCTION_SHA,
    jti: `test-jti-${crypto.randomUUID()}`,
    nbf: now - 5,
    ref: "refs/heads/develop",
    repository: "zevium-dev/core",
    repository_id: "1044451612",
    repository_owner: "zevium-dev",
    repository_owner_id: "228443220",
    repository_visibility: "public",
    run_attempt: "1",
    run_id: "9002",
    sha: PRODUCTION_SHA,
    sub: "repo:zevium-dev/core:environment:production",
    workflow_ref:
      "zevium-dev/core/.github/workflows/deploy-production.yml@refs/heads/develop",
    workflow_sha: PRODUCTION_SHA,
    ...overrides,
  };
}

export function stagingClaims(
  audience: string,
  overrides: Partial<GitHubOidcClaims> = {},
): GitHubOidcClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    actor: "tnfssc",
    actor_id: "29162020",
    aud: audience,
    base_ref: "",
    environment: "staging",
    event_name: "workflow_dispatch",
    exp: now + 300,
    head_ref: "",
    iat: now,
    iss: "https://token.actions.githubusercontent.com",
    job_workflow_ref:
      "zevium-dev/core/.github/workflows/cloudflare-staging.yml@refs/heads/develop",
    job_workflow_sha: HEAD_SHA,
    jti: `test-jti-${crypto.randomUUID()}`,
    nbf: now - 5,
    ref: "refs/heads/develop",
    repository: "zevium-dev/core",
    repository_id: "1044451612",
    repository_owner: "zevium-dev",
    repository_owner_id: "228443220",
    repository_visibility: "public",
    run_attempt: "1",
    run_id: "9003",
    sha: HEAD_SHA,
    sub: "repo:zevium-dev/core:environment:staging",
    workflow_ref:
      "zevium-dev/core/.github/workflows/staging-proof.yml@refs/heads/develop",
    workflow_sha: HEAD_SHA,
    ...overrides,
  };
}

export async function signClaims(
  claims: GitHubOidcClaims,
  header: Record<string, unknown> = {
    alg: "RS256",
    kid: TEST_PUBLIC_JWK.kid,
    typ: "JWT",
  },
): Promise<string> {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(claims));
  const input = Uint8Array.from(
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, input.buffer),
  );
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

export function pullRequestFixture() {
  return {
    base: {
      ref: "develop",
      repo: { full_name: "zevium-dev/core", id: 1044451612 },
    },
    head: {
      ref: "broker-branch",
      repo: { full_name: "zevium-dev/core", id: 1044451612 },
      sha: HEAD_SHA,
    },
    merge_commit_sha: MERGE_SHA,
    merged: false,
    number: 123,
    state: "open",
  };
}
