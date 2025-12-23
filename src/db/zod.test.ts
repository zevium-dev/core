import { describe, expect, it } from "vitest";

import { CiphertextZod } from "./zod";

describe("CiphertextZod", () => {
  it("should validate a correct ciphertext format", () => {
    const valid = "v1:YWFhYWFhYWFhYWFh:YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
    expect(CiphertextZod.safeParse(valid).success).toBe(true);
  });

  it("should validate with empty components if they are valid base64 (empty string is valid base64 in Zod)", () => {
    // keyId cannot be empty based on the current implementation of CiphertextZod
    // but iv and ciphertext can be empty strings (which Zod considers valid base64)
    expect(CiphertextZod.safeParse("keyId::").success).toBe(true);
  });

  it("should reject invalid number of parts", () => {
    expect(CiphertextZod.safeParse("keyId:base64").success).toBe(false);
    expect(CiphertextZod.safeParse("keyId:base64:base64:extra").success).toBe(false);
  });

  it("should reject empty keyId", () => {
    expect(CiphertextZod.safeParse(":iv:ct").success).toBe(false);
  });

  it("should reject invalid base64 in IV", () => {
    expect(CiphertextZod.safeParse("v1:invalid-base64-!!!:YWFh").success).toBe(false);
  });

  it("should reject invalid base64 in ciphertext", () => {
    expect(CiphertextZod.safeParse("v1:YWFh:invalid-base64-!!!").success).toBe(false);
  });

  it("should reject only padding strings (====) as they are invalid base64", () => {
    expect(CiphertextZod.safeParse("v1:====:YWFh").success).toBe(false);
    expect(CiphertextZod.safeParse("v1:YWFh:====").success).toBe(false);
  });
});
