import { describe, expect, it } from "vitest";

import { hashString } from "./";

describe("hashString", () => {
  it("produces consistent hashes", async () => {
    const input = "Hello, world!";
    const hash1 = await hashString(input);
    const hash2 = await hashString(input);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const input1 = "Hello, world!";
    const input2 = "Goodbye, world!";
    const hash1 = await hashString(input1);
    const hash2 = await hashString(input2);
    expect(hash1).not.toBe(hash2);
  });
});
