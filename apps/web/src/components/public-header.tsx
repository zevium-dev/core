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
          <nav className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
            <Link
              to="/catalogue"
              className={cn(
                "transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground",
                active === "catalogue" && "text-foreground",
              )}
            >
              Catalogue
            </Link>
            <Link
              to="/docs"
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
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X /> : <Menu />}
          </Button>
          <Button asChild variant="ghost" size="icon-sm">
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
          <div className="flex h-9 min-w-[9.5rem] items-center justify-end gap-2">
            <Show
              when="signed-out"
              fallback={
                <>
                  <Button asChild variant="ghost" size="sm">
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
          aria-label="Public navigation"
          className="flex flex-col gap-1 border-t px-4 py-3 text-sm sm:hidden"
        >
          <Link
            to="/catalogue"
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
            onClick={() => setMobileOpen(false)}
            className={cn(
              "rounded-md px-3 py-2 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active === "docs" && "bg-muted",
            )}
          >
            Docs
          </Link>
        </nav>
      ) : null}
    </header>
  );
}
