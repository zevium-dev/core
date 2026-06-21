/* eslint-disable perfectionist/sort-modules */
import { lookup } from "node:dns/promises";
import isPrivate from "private-ip";

export type DnsLookupFn = typeof lookup;

const DEFAULT_DNS_CACHE_TTL_MS = 60_000;
const MAX_DNS_CACHE_ENTRIES = 1024;

interface DnsCacheEntry {
  expiresAtMs: number;
  isLocalOrPrivate: boolean;
}

const dnsPrivateHostCache = new Map<string, DnsCacheEntry>();

function pruneDnsPrivateHostCache(nowMs: number) {
  for (const [host, entry] of dnsPrivateHostCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      dnsPrivateHostCache.delete(host);
    }
  }

  while (dnsPrivateHostCache.size > MAX_DNS_CACHE_ENTRIES) {
    const oldestKey = dnsPrivateHostCache.keys().next().value;
    if (!oldestKey) break;
    dnsPrivateHostCache.delete(oldestKey);
  }
}

function normalizeAllowlistEntry(rawEntry: string): null | string {
  const entry = rawEntry.trim().toLowerCase();
  if (!entry) return null;

  // Support exact hosts and wildcard subdomains like *.example.com.
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(2);
    if (!suffix || suffix.includes("*") || suffix.startsWith(".")) {
      return null;
    }
    return `*.${suffix}`;
  }

  if (entry.includes("*")) return null;
  return entry.startsWith(".") ? entry.slice(1) : entry;
}

export function parseProxyAllowlist(rawAllowlist: string | undefined): Array<string> {
  if (!rawAllowlist) return [];

  const uniqueEntries = new Set<string>();
  for (const rawEntry of rawAllowlist.split(/[\s,]+/)) {
    const normalized = normalizeAllowlistEntry(rawEntry);
    if (!normalized) continue;
    uniqueEntries.add(normalized);
  }

  return Array.from(uniqueEntries);
}

export function isHostAllowlisted(hostname: string, allowlist: Array<string>): boolean {
  const host = hostname.toLowerCase();

  for (const allowlistEntry of allowlist) {
    if (allowlistEntry === host) return true;

    if (!allowlistEntry.startsWith("*.")) continue;
    const suffix = allowlistEntry.slice(1);

    // Wildcards should match subdomains only (foo.example.com), not the apex domain itself.
    if (host.length > suffix.length && host.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}

export function normalizeProxySecret(rawSecret: string | undefined): null | string {
  const normalized = rawSecret?.trim();
  if (!normalized) return null;
  return normalized;
}

export function isLoopbackAddress(addr: string): boolean {
  return (
    /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/.test(addr) ||
    addr.startsWith("0177.") ||
    /^0x7f\./i.test(addr) ||
    /^fe80::1$/i.test(addr) ||
    /^::1$/.test(addr) ||
    /^::$/.test(addr)
  );
}

export async function isLocalOrPrivateHost(
  hostname: string,
  options?: {
    dnsLookup?: DnsLookupFn;
    nowMs?: () => number;
    ttlMs?: number;
  },
): Promise<boolean> {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;

  const nowMsFn = options?.nowMs ?? Date.now;
  const nowMs = nowMsFn();
  const cached = dnsPrivateHostCache.get(host);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.isLocalOrPrivate;
  }

  let isLocalOrPrivate: boolean;
  try {
    const dnsLookup = options?.dnsLookup ?? lookup;
    const results = await dnsLookup(host, { all: true, verbatim: true });
    isLocalOrPrivate = results.some(({ address }) => (isPrivate(address) ?? false) || isLoopbackAddress(address));
  } catch {
    // Fail closed on DNS errors.
    isLocalOrPrivate = true;
  }

  const ttlMs = Math.max(1_000, options?.ttlMs ?? DEFAULT_DNS_CACHE_TTL_MS);
  dnsPrivateHostCache.set(host, {
    expiresAtMs: nowMs + ttlMs,
    isLocalOrPrivate,
  });
  pruneDnsPrivateHostCache(nowMs);

  return isLocalOrPrivate;
}

export function clearProxySecurityCacheForTests() {
  dnsPrivateHostCache.clear();
}
