// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("#/components/syntax-code", () => ({
  SyntaxCode: ({ code }: { code: string }) => <code>{code}</code>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { AgentInstall } from "./agent-install";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function selectClient(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

describe("AgentInstall", () => {
  it("copies each client's config and exposes a placeholder-only Cursor install action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<AgentInstall gatewayOrigin="https://edge.example.test/gateway/" />);
    expect(
      screen
        .getByRole("link", { name: "Settings → Keys" })
        .getAttribute("href"),
    ).toBe("/app/settings/keys");
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Claude Code command" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining(
          "claude mcp add --transport http zevium 'https://edge.example.test/mcp'",
        ),
      ),
    );

    selectClient("Cursor");
    const install = new URL(
      screen
        .getByRole("link", { name: "Install in Cursor" })
        .getAttribute("href")!,
    );
    const config = JSON.parse(
      Buffer.from(install.searchParams.get("config")!, "base64").toString(
        "utf8",
      ),
    );
    expect(config.headers.Authorization).toBe("Bearer ak_YOUR_API_KEY");
    fireEvent.click(screen.getByRole("button", { name: "Copy Cursor config" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        expect.stringContaining('"mcpServers"'),
      ),
    );

    selectClient("Codex");
    fireEvent.click(screen.getByRole("button", { name: "Copy Codex config" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        expect.stringContaining("[mcp_servers.zevium]"),
      ),
    );
  });

  it("keeps the snippet selectable and reports clipboard failure", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<AgentInstall gatewayOrigin="https://edge.example.test" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Claude Code command" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Copy failed. Select and copy manually.",
      ),
    );
    expect(
      screen.getByRole("region", { name: "bash example" }).textContent,
    ).toContain("Bearer ak_YOUR_API_KEY");
  });
});
