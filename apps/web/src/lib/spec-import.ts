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
          return url.protocol === "http:" || url.protocol === "https:";
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
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid URL",
    };
  }
  return { ok: true, data: parsed.data };
}

/** Client RPC facade. All authorization and network work stays server-only. */
export const fetchSpecFromUrl = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = parseImportSpecUrl(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.data;
  })
  .handler(async ({ data }) => {
    const { fetchSpecFromUrlServerBoundary } =
      await import("./spec-import.server");
    return await fetchSpecFromUrlServerBoundary(data);
  });
