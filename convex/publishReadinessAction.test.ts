import { describe, expect, it } from "vitest";
import {
  classifyConnectionStatus,
  isBlockedIpv6,
  isPrivateIpv4,
  safeResponseMessage,
} from "./publishReadinessAction";

describe("publish readiness upstream guard", () => {
  it("blocks private, link-local, and loopback IPv4 destinations", () => {
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateIpv4("10.0.0.8")).toBe(true);
    expect(isPrivateIpv4("169.254.169.254")).toBe(true);
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("blocks loopback and private IPv6 destinations", () => {
    expect(isBlockedIpv6("::1")).toBe(true);
    expect(isBlockedIpv6("[::1]")).toBe(true);
    expect(isBlockedIpv6("[::]")).toBe(true);
    expect(isBlockedIpv6("fd00::1")).toBe(true);
    expect(isBlockedIpv6("fe80::1")).toBe(true);
    expect(isBlockedIpv6("ff02::1")).toBe(true);
    expect(isBlockedIpv6("[::ffff:127.0.0.1]")).toBe(true);
    expect(isBlockedIpv6("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isBlockedIpv6("2606:4700:4700::1111")).toBe(false);
  });

  it("gives publishers an actionable authentication result", () => {
    expect(classifyConnectionStatus(401)).toBe("auth_rejected");
    expect(classifyConnectionStatus(404)).toBe("reachable_unconfirmed");
    expect(safeResponseMessage(401, true)).toContain("rejected");
    expect(safeResponseMessage(401, false)).toContain("Add the publisher");
    expect(safeResponseMessage(404, false)).toContain("HTTP 404");
    expect(safeResponseMessage(204, true)).toContain("credentials");
  });
});
