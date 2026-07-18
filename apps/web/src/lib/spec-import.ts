import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const MAX_SPEC_IMPORT_BYTES = 2 * 1024 * 1024;

export const importSpecUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Enter a valid URL")
    .refine(
      (value) => {
        try {
          const u = new URL(value);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "URL must be http(s)" },
    ),
});

export type ImportSpecUrlInput = z.infer<typeof importSpecUrlSchema>;

export function parseImportSpecUrl(
  input: unknown,
): { ok: true; data: ImportSpecUrlInput } | { ok: false; error: string } {
  const parsed = importSpecUrlSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid URL",
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Fetch OpenAPI text server-side (avoids CORS). Size hard-cap 2MB.
 */
export const fetchSpecFromUrl = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = parseImportSpecUrl(input);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.data;
  })
  .handler(
    async ({ data }): Promise<{ text: string; contentType: string | null }> => {
      let response: Response;
      try {
        response = await fetch(data.url, {
          method: "GET",
          redirect: "follow",
          headers: {
            Accept:
              "application/json, application/yaml, text/yaml, text/plain, */*",
          },
        });
      } catch {
        throw new Error("Could not reach that URL");
      }

      if (!response.ok) {
        throw new Error(`URL returned HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type");
      const lengthHeader = response.headers.get("content-length");
      if (lengthHeader !== null) {
        const n = Number(lengthHeader);
        if (Number.isFinite(n) && n > MAX_SPEC_IMPORT_BYTES) {
          throw new Error("Spec is larger than 2MB");
        }
      }

      const buf = await response.arrayBuffer();
      if (buf.byteLength > MAX_SPEC_IMPORT_BYTES) {
        throw new Error("Spec is larger than 2MB");
      }

      const text = new TextDecoder("utf-8").decode(buf);
      if (text.trim() === "") {
        throw new Error("URL returned empty body");
      }

      return { text, contentType };
    },
  );
