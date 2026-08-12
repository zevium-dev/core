import { describe, expect, it } from "vitest";
import { resetJwksCacheForTest, verifyGitHubOidc } from "../../src/jwt";
import { previewClaims, signClaims, TEST_PUBLIC_JWK } from "../fixtures";

const AUDIENCE = `urn:zevium:cloudflare-deploy:v2:${"d".repeat(64)}`;

async function verify(token: string, nowSeconds?: number) {
  return verifyGitHubOidc(token, AUDIENCE, {
    ...(nowSeconds === undefined ? {} : { nowSeconds }),
    resolveJwk: async () => TEST_PUBLIC_JWK,
  });
}

describe("GitHub OIDC verification", () => {
  it("accepts a valid RS256 token with exact claims", async () => {
    const claims = previewClaims(AUDIENCE);
    await expect(verify(await signClaims(claims))).resolves.toEqual(claims);
  });

  it.each([
    ["issuer", { iss: "https://evil.invalid" }, "invalid_issuer"],
    ["audience", { aud: `${AUDIENCE}-other` }, "invalid_audience"],
    ["missing jti", { jti: "" }, "invalid_claims"],
    ["repository id", { repository_id: "not-numeric" }, "invalid_claims"],
    ["workflow sha", { workflow_sha: "A".repeat(40) }, "invalid_claims"],
  ])("rejects forged %s claim", async (_label, overrides, code) => {
    const token = await signClaims(previewClaims(AUDIENCE, overrides));
    await expect(verify(token)).rejects.toMatchObject({ code });
  });

  it("rejects expired, future, stale, and oversized-lifetime tokens", async () => {
    const now = 2_000_000_000;
    for (const claims of [
      previewClaims(AUDIENCE, { exp: now, iat: now - 30, nbf: now - 30 }),
      previewClaims(AUDIENCE, { exp: now + 300, iat: now + 60, nbf: now + 60 }),
      previewClaims(AUDIENCE, {
        exp: now + 60,
        iat: now - 121,
        nbf: now - 121,
      }),
      previewClaims(AUDIENCE, { exp: now + 700, iat: now, nbf: now }),
    ]) {
      await expect(verify(await signClaims(claims), now)).rejects.toBeDefined();
    }
  });

  it("rejects alg confusion and tampered signatures", async () => {
    const claims = previewClaims(AUDIENCE);
    await expect(
      verify(
        await signClaims(claims, {
          alg: "none",
          kid: "test-key-1",
          typ: "JWT",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_token" });

    const valid = await signClaims(claims);
    const segments = valid.split(".");
    const signature = segments[2] ?? "";
    const first = signature[0] ?? "a";
    const forged = `${segments[0]}.${segments[1]}.${first === "a" ? "b" : "a"}${signature.slice(1)}`;
    await expect(verify(forged)).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("rejects noncanonical base64url and token whitespace", async () => {
    const token = await signClaims(previewClaims(AUDIENCE));
    await expect(verify(`${token}=`)).rejects.toMatchObject({
      code: "invalid_token",
    });
    await expect(verify(token.replace(".", ".\n"))).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("refreshes once for a rotated kid and then caches JWKS", async () => {
    resetJwksCacheForTest();
    const rotated = { ...TEST_PUBLIC_JWK, kid: "rotated-key" };
    const token = await signClaims(previewClaims(AUDIENCE), {
      alg: "RS256",
      kid: "rotated-key",
      typ: "JWT",
    });
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json(
        { keys: calls === 1 ? [TEST_PUBLIC_JWK] : [rotated] },
        { headers: { "content-type": "application/json" } },
      );
    };
    await expect(
      verifyGitHubOidc(token, AUDIENCE, { fetcher }),
    ).resolves.toMatchObject({ aud: AUDIENCE });
    await expect(
      verifyGitHubOidc(token, AUDIENCE, { fetcher }),
    ).resolves.toMatchObject({ aud: AUDIENCE });
    expect(calls).toBe(2);
  });

  it("rejects JWKS redirects and throttles signature-triggered refresh", async () => {
    resetJwksCacheForTest();
    const token = await signClaims(previewClaims(AUDIENCE));
    await expect(
      verifyGitHubOidc(token, AUDIENCE, {
        fetcher: async () => new Response(null, { status: 302 }),
      }),
    ).rejects.toMatchObject({ code: "jwks_redirect_rejected" });

    resetJwksCacheForTest();
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json(
        { keys: [TEST_PUBLIC_JWK] },
        { headers: { "content-type": "application/json" } },
      );
    };
    await verifyGitHubOidc(token, AUDIENCE, { fetcher });
    const segments = token.split(".");
    const signature = segments[2] ?? "";
    const forged = `${segments[0]}.${segments[1]}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    await expect(
      verifyGitHubOidc(forged, AUDIENCE, { fetcher }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(
      verifyGitHubOidc(forged, AUDIENCE, { fetcher }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    expect(calls).toBe(2);
  });
});
