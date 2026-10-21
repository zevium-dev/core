/** Anonymous semantic-search budgets key on the caller's network, never on a
 * caller-supplied id: IPv4 per address, IPv6 per /64 so one host can't rotate
 * addresses within its prefix. */
export function searchNetwork(ip: string): string {
  if (!ip.includes(":")) return ip;
  const canonical = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words =
    right === undefined
      ? head
      : [
          ...head,
          ...Array<string>(8 - head.length - tail.length).fill("0"),
          ...tail,
        ];
  return `${words
    .slice(0, 4)
    .map((w) => w.padStart(4, "0"))
    .join(":")}/64`;
}

/** Only a request Cloudflare actually terminated carries a trustworthy client IP. */
export function trustedClientIp(request: Request): string | null {
  const ip =
    "cf" in request && request.cf
      ? request.headers.get("cf-connecting-ip")
      : null;
  return typeof ip === "string" && ip.length > 0 && ip.length <= 64 ? ip : null;
}

/** HMAC of the caller network; the control plane rate-limits on this opaque key. */
export async function anonymousSearchKey(
  secret: string,
  ip: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(searchNetwork(ip)),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
