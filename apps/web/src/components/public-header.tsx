import { Show, UserButton } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { Link } from "@tanstack/react-router";
import { Github, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import { BrandMark } from "#/components/brand-mark";
import { ThemeToggle } from "#/components/theme-toggle";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

type PublicHeaderProps = {
  /** Highlight Catalogue / Docs nav when on those routes. */
  active?: "catalogue" | "docs" | null;
  className?: string;
};

const GITHUB_URL = "https://github.com/zevium-dev/core";

/**
 * Shared public chrome for landing + catalogue.
 * Session-aware auth slot via Clerk <Show when="signed-in|signed-out">
 * (Clerk v6 renamed SignedIn/SignedOut → Show).
 * Auth slot has fixed min-width so swap never shifts layout.
 */
export function PublicHeader({ active = null, className }: PublicHeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
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
              className="flex items-center gap-0.5 text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
                  "transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground",
                  active === "catalogue" && "text-foreground",
                )}
              >
                Catalogue
              </Link>
              <Link
                to="/docs"
                aria-current={active === "docs" ? "page" : undefined}
                className={cn(
                  "transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground",
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
              className="sm:hidden"
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
            <ThemeToggle />
            {/* Fixed-width auth slot: prevents Sign in ↔ Dashboard+UserButton shift */}
            <div className="flex h-9 min-w-0 items-center justify-end gap-2 sm:min-w-[9.5rem]">
              <Show
                when="signed-out"
                fallback={
                  <>
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className="hidden sm:inline-flex"
                    >
                      <Link to="/app">Dashboard</Link>
                    </Button>
                    <UserButton appearance={{ theme: shadcn }} />
                  </>
                }
              >
                <Button asChild variant="outline" size="sm">
                  <Link to="/sign-in/$">Sign in</Link>
                </Button>
              </Show>
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
                "rounded-md px-3 py-2 focus-visible:ring-[3px] focus-visible:ring-ring/50",
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
                "rounded-md px-3 py-2 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active === "docs" && "bg-muted",
              )}
            >
              Docs
            </Link>
            <Show when="signed-in">
              <Link
                to="/app"
                onClick={() => setMobileOpen(false)}
                className="rounded-md px-3 py-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Dashboard
              </Link>
            </Show>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-3 py-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              GitHub
            </a>
          </nav>
        ) : null}
      </header>
    </>
  );
}
