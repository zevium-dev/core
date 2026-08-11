import { Link, useRouterState } from "@tanstack/react-router";
import { Github, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import { BrandMark } from "#/components/brand-mark";
import { ThemeToggle } from "#/components/theme-toggle";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import type { RouterContext } from "#/router";

type PublicHeaderProps = {
  /** Highlight Catalogue / Docs nav when on those routes. */
  active?: "catalogue" | "docs" | null;
  className?: string;
};

const GITHUB_URL = "https://github.com/zevium-dev/core";

/**
 * Shared public chrome for landing + catalogue.
 * Server-authenticated route context keeps public chrome session-aware without
 * loading Clerk's hosted UI on anonymous catalogue and docs routes.
 */
export function PublicHeader({ active = null, className }: PublicHeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const signedIn = useRouterState({
    select: (state) =>
      Boolean(
        (state.matches[0]?.context as Partial<RouterContext> | undefined)
          ?.userId,
      ),
  });
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <>
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-50 -translate-y-24 rounded-md bg-background px-3 py-2 text-sm font-medium shadow-md outline-none transition-transform duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:translate-y-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
      >
        Skip to content
      </a>
      <header className={cn("border-b", className)}>
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-6">
            <Link
              to="/"
              aria-label="Zevium"
              className="-ml-2 flex min-h-11 items-center gap-0.5 rounded-md px-2 text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <BrandMark className="h-3 w-4" />
              <span aria-hidden="true">evium</span>
            </Link>
            <nav
              className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex"
              aria-label="Primary"
            >
              <Link
                to="/catalogue"
                aria-current={active === "catalogue" ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-md px-1 transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground",
                  active === "catalogue" && "text-foreground",
                )}
              >
                Catalogue
              </Link>
              <Link
                to="/docs"
                aria-current={active === "docs" ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-md px-1 transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground",
                  active === "docs" && "text-foreground",
                )}
              >
                Docs
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 sm:hidden"
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileOpen}
              aria-controls="public-mobile-navigation"
              onClick={() => setMobileOpen((open) => !open)}
            >
              {mobileOpen ? <X /> : <Menu />}
            </Button>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="hidden sm:inline-flex"
            >
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Open Zevium on GitHub"
              >
                <Github data-icon="inline-start" />
              </a>
            </Button>
            <ThemeToggle className="size-11 sm:size-9" />
            {/* Fixed-width desktop slot prevents session-state layout shift. */}
            <div className="flex h-9 min-w-0 items-center justify-end gap-2 sm:min-w-[9.5rem]">
              {signedIn ? (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-11 sm:h-8"
                >
                  <Link to="/app">Dashboard</Link>
                </Button>
              ) : (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-11 sm:h-8"
                >
                  <Link to="/sign-in/$">Sign in</Link>
                </Button>
              )}
            </div>
          </div>
        </div>
        {mobileOpen ? (
          <nav
            id="public-mobile-navigation"
            aria-label="Public navigation"
            className="flex flex-col gap-1 border-t px-4 py-3 text-sm sm:hidden"
          >
            <Link
              to="/catalogue"
              aria-current={active === "catalogue" ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "rounded-md px-3 py-3 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active === "catalogue" && "bg-muted",
              )}
            >
              Catalogue
            </Link>
            <Link
              to="/docs"
              aria-current={active === "docs" ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "rounded-md px-3 py-3 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active === "docs" && "bg-muted",
              )}
            >
              Docs
            </Link>
            {signedIn ? (
              <Link
                to="/app"
                onClick={() => setMobileOpen(false)}
                className="rounded-md px-3 py-3 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Dashboard
              </Link>
            ) : null}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-3 py-3 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              GitHub
            </a>
          </nav>
        ) : null}
      </header>
    </>
  );
}
