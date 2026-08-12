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
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.port === "" &&
            url.username === "" &&
            url.password === ""
          );
        } catch {
          return false;
        }
      },
      {
        message: "URL must use HTTPS on port 443 and omit credentials",
      },
    ),
});

export type ImportSpecUrlInput = z.infer<typeof importSpecUrlSchema>;

export function parseImportSpecUrl(
  input: unknown,
): { ok: true; data: ImportSpecUrlInput } | { ok: false; error: string } {
  const parsed = importSpecUrlSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid URL",
    };
  }
  return { ok: true, data: parsed.data };
}

/** Fetch OpenAPI text server-side (avoids CORS). Size hard-cap 2MB. */
export const fetchSpecFromUrl = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = parseImportSpecUrl(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.data;
  })
  .handler(async ({ data }) => {
    const { fetchSpecFromUrlForRequest } = await import("./spec-import.server");
    return await fetchSpecFromUrlForRequest(data);
  });
