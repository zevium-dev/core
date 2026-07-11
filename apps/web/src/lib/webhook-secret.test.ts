import { describe, expect, it } from "vitest";

import {
  generateWebhookSecret,
  isHexSecret,
  maskSecret,
  toHex,
} from "./webhook-secret";

describe("toHex", () => {
  it("encodes bytes as lowercase hex", () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
    expect(toHex(new Uint8Array([]))).toBe("");
  });

  it("always pads to two chars per byte", () => {
    expect(toHex(new Uint8Array([1, 2, 3]))).toBe("010203");
  });
});

describe("generateWebhookSecret", () => {
  it("produces hex of the right length (2 chars per byte)", () => {
    expect(generateWebhookSecret(32)).toHaveLength(64);
    expect(generateWebhookSecret(16)).toHaveLength(32);
    expect(generateWebhookSecret(0)).toHaveLength(0);
  });

  it("is lowercase hex", () => {
    expect(isHexSecret(generateWebhookSecret(32))).toBe(true);
  });

  it("produces unique values across calls", () => {
    const a = generateWebhookSecret(32);
    const b = generateWebhookSecret(32);
    expect(a).not.toBe(b);
  });
});

describe("isHexSecret", () => {
  it("accepts even-length lowercase hex", () => {
    expect(isHexSecret("deadbeef")).toBe(true);
    expect(isHexSecret("0123456789abcdef")).toBe(true);
  });

  it("accepts a 0x prefix", () => {
    expect(isHexSecret("0xdeadbeef")).toBe(true);
  });

  it("rejects odd length, uppercase, non-hex, empty", () => {
    expect(isHexSecret("abc")).toBe(false);
    expect(isHexSecret("DEADBEEF")).toBe(false);
    expect(isHexSecret("nothex!")).toBe(false);
    expect(isHexSecret("")).toBe(false);
  });
});

describe("maskSecret", () => {
  it("reveals only edges for long secrets", () => {
    const out = maskSecret("abcdefghijklmnopqrstuvwx");
    expect(out.startsWith("abcd")).toBe(true);
    expect(out.endsWith("uvwx")).toBe(true);
    expect(out).toContain("•");
    // Middle masked, edges preserved
    expect(out.replace(/•/g, "")).toBe("abcduvwx");
  });

  it("fully masks very short secrets", () => {
    expect(maskSecret("ab")).toBe("••");
    expect(maskSecret("abcd")).toBe("••••");
  });
});
