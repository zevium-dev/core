// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ORG_CAPABILITIES,
  type OrgCapabilityProjection,
  type OrgRole,
} from "#/lib/org-capabilities";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): Record<string, unknown> => ({
      ...options,
      fullPath: "/app/billing",
      useSearch: () => ({}),
    }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { CycleUsage } from "./billing";

function access(role: OrgRole, viewOrgUsage: boolean): OrgCapabilityProjection {
  return {
    role,
    capabilities: Object.fromEntries(
      ORG_CAPABILITIES.map((capability) => [
        capability,
        capability === "viewOrgUsage" ? viewOrgUsage : true,
      ]),
    ) as OrgCapabilityProjection["capabilities"],
    reasons: Object.fromEntries(
      ORG_CAPABILITIES.map((capability) => [
        capability,
        capability === "viewOrgUsage" && !viewOrgUsage
          ? "Members see only usage attributed to their identity."
          : null,
      ]),
    ) as OrgCapabilityProjection["reasons"],
  };
}

function cycle(role: OrgRole, viewOrgUsage: boolean) {
  const memberRows = [
    {
      memberId: "user_colleague",
      name: "Colleague Secret",
      email: "colleague@example.com",
      calls: 3,
      credits: 9,
    },
  ];
  return {
    access: access(role, viewOrgUsage),
    scope: viewOrgUsage ? ("organization" as const) : ("member" as const),
    cycleStart: Date.UTC(2026, 7, 1),
    cycleEnd: Date.UTC(2026, 8, 1),
    asOf: Date.UTC(2026, 7, 12),
    totalCalls: 4,
    totalCredits: 12,
    ownCalls: viewOrgUsage ? null : 1,
    ownCredits: viewOrgUsage ? null : 3,
    projectedCredits: 36,
    byProject: [],
    byKey: [
      {
        keyId: "key_super_secret_123456789",
        keyName: "Own key",
        memberId: viewOrgUsage ? "user_colleague" : null,
        calls: 1,
        credits: 3,
      },
    ],
    byMember: memberRows,
    byEndpoint: [],
    breakdownTruncated: {
      members: false,
      keys: false,
      projects: false,
      endpoints: false,
    },
  };
}

describe("billing capability projection", () => {
  it("never renders member rows, email, or full key ids for members", () => {
    const { container } = render(
      <CycleUsage cycle={cycle("org:member", false)} />,
    );

    expect(screen.getByText("Your keys")).toBeTruthy();
    expect(screen.queryByText("By member")).toBeNull();
    expect(container.innerHTML).not.toContain("Colleague Secret");
    expect(container.innerHTML).not.toContain("colleague@example.com");
    expect(container.innerHTML).not.toContain("key_super_secret_123456789");
  });

  it("renders server-approved member names without email addresses", () => {
    const { container } = render(
      <CycleUsage cycle={cycle("org:admin", true)} />,
    );

    expect(screen.getByText("By member")).toBeTruthy();
    expect(screen.getByText("Colleague Secret")).toBeTruthy();
    expect(container.innerHTML).not.toContain("colleague@example.com");
  });
});
