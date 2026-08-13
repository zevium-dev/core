export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
