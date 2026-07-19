import { describe, expect, it } from "vitest";

import { tryItBodyDefaults } from "./try-it";

describe("tryItBodyDefaults", () => {
  it("uses text media type and schema example", () => {
    expect(
      tryItBodyDefaults({
        requestBody: {
          content: {
            "text/plain": {
              schema: { type: "string", example: "# Hello" },
            },
          },
        },
      }),
    ).toEqual({ contentType: "text/plain", body: "# Hello" });
  });

  it("prefers JSON and serializes object examples", () => {
    expect(
      tryItBodyDefaults({
        requestBody: {
          content: {
            "text/plain": { example: "ignored" },
            "application/json": { example: { message: "hello" } },
          },
        },
      }),
    ).toEqual({
      contentType: "application/json",
      body: '{\n  "message": "hello"\n}',
    });
  });

  it("falls back to empty JSON body when request metadata is absent", () => {
    expect(tryItBodyDefaults({})).toEqual({
      contentType: "application/json",
      body: "{\n  \n}",
    });
  });
});
