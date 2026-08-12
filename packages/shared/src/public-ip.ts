function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (
    octets.some(
      (part, index) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255 ||
        String(part) !== parts[index],
    )
  ) {
    return null;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0) >>> 0;
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  const shift = 32 - prefix;
  return value >>> shift === base >>> shift;
}

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

function isPublicIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  return !BLOCKED_IPV4_CIDRS.some(([base, prefix]) =>
    ipv4InCidr(value, parseIpv4(base)!, prefix),
  );
}

function parseIpv6(address: string): bigint | null {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.includes("%")) return null;
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail !== undefined) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, -ipv4Tail.length)}${(
      ipv4 >>> 16
    ).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right =
    halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  const groups = [
    ...left,
    ...Array<number>(Math.max(0, missing)).fill(0),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(String(group)))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) =>
      (value << 16n) | BigInt(Number.parseInt(String(group), 16)),
    0n,
  );
}

function ipv6InCidr(value: bigint, base: bigint, prefix: number): boolean {
  const shift = 128n - BigInt(prefix);
  return value >> shift === base >> shift;
}

const BLOCKED_IPV6_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const;

function isPublicIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return false;
  if (!ipv6InCidr(value, parseIpv6("2000::")!, 3)) return false;
  return !BLOCKED_IPV6_CIDRS.some(([base, prefix]) =>
    ipv6InCidr(value, parseIpv6(base)!, prefix),
  );
}

/** True only for canonical, globally routable IPv4 or IPv6 addresses. */
export function isPublicIp(address: string): boolean {
  return isPublicIpv4(address) || isPublicIpv6(address);
}
