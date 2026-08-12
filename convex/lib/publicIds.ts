const encoder = new TextEncoder();

/** Irreversible stable reference for member/admin DTOs. */
export async function publicReference(
  namespace: string,
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${namespace}\u0000${value}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function maskedSuffix(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
