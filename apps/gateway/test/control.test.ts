import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyControlRequest, type ControlPayload } from "../src/control";

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function signedRequest(
  payload: ControlPayload,
  secret: string,
  at: number,
) {
  const body = JSON.stringify(payload);
  const nonce = "nonce-control-test";
  const timestamp = String(at);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return new Request("https://gateway.test/internal/registry/v1/catalogue", {
    method: "POST",
    headers: {
      "x-zevium-timestamp": timestamp,
      "x-zevium-nonce": nonce,
      "x-zevium-signature": `v1=${hex(signature)}`,
      "x-zevium-control-digest": `sha256=${hex(digest)}`,
    },
    body,
  });
}

describe("signed durable route controls", () => {
  it("authenticates exact payload and rejects stale signatures", async () => {
    const now = 1_800_000_000_000;
    const payload: ControlPayload = {
      entityKey: "catalogue:project",
      sourceRevision: 2,
      operation: "catalogue.state",
      publisherHandle: "publisher",
      projectSlug: "api",
      discoverable: false,
    };
    await expect(
      verifyControlRequest(
        await signedRequest(payload, "secret", now),
        "secret",
        now,
      ),
    ).resolves.toMatchObject({ payload });
    await expect(
      verifyControlRequest(
        await signedRequest(payload, "secret", now - 300_001),
        "secret",
        now,
      ),
    ).resolves.toBeNull();
  });

  it("applies monotonic revisions and blocks next local edge lookup", async () => {
    if (!env.CONTROL) throw new Error("CONTROL binding missing");
    const stub = env.CONTROL.get(env.CONTROL.idFromName("control-test"));
    const payload: ControlPayload = {
      entityKey: "catalogue:project",
      sourceRevision: 3,
      operation: "catalogue.state",
      publisherHandle: "publisher",
      projectSlug: "api",
      discoverable: false,
    };
    const applied = await stub.fetch("https://control.invalid/apply", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(await applied.json()).toEqual({ status: "applied" });
    const duplicate = await stub.fetch("https://control.invalid/apply", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(await duplicate.json()).toEqual({ status: "duplicate" });
    const gate = await stub.fetch(
      "https://control.invalid/gate?route=publisher%2Fapi",
    );
    expect(await gate.json()).toEqual({ allowed: false, sourceRevision: 3 });
  });

  it("blocks every publisher route after archived organization control", async () => {
    if (!env.CONTROL) throw new Error("CONTROL binding missing");
    const stub = env.CONTROL.get(env.CONTROL.idFromName("archive-test"));
    const applied = await stub.fetch("https://control.invalid/apply", {
      method: "POST",
      body: JSON.stringify({
        entityKey: "org:org_archived",
        sourceRevision: 4,
        operation: "org.archive",
        publisherHandle: "archived-publisher",
        archived: true,
      } satisfies ControlPayload),
    });
    expect(await applied.json()).toEqual({ status: "applied" });
    const gate = await stub.fetch(
      "https://control.invalid/gate?route=archived-publisher%2Fany-api",
    );
    expect(await gate.json()).toEqual({ allowed: false, sourceRevision: 4 });
  });
});
