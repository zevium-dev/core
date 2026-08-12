// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrgCapabilityNotice } from "./org-capability-notice";

describe("OrgCapabilityNotice", () => {
  it("renders exact server-projected denial reason", () => {
    render(<OrgCapabilityNotice reason="Server denied billing access." />);
    expect(screen.getByRole("note").textContent).toBe(
      "Server denied billing access.",
    );
  });

  it("renders nothing for an allowed capability", () => {
    const { container } = render(<OrgCapabilityNotice reason={null} />);
    expect(container.childElementCount).toBe(0);
  });
});
