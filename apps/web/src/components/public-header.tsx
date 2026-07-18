import { Show, UserButton } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { Link } from "@tanstack/react-router";

import { BrandMark } from "#/components/brand-mark";
import { ThemeToggle } from "#/components/theme-toggle";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

type PublicHeaderProps = {
  /** Max content width utility, default max-w-5xl (landing). Catalogue uses max-w-6xl. */
  maxWidthClass?: string;
  /** Highlight Catalogue / Docs nav when on those routes. */
  active?: "catalogue" | "docs" | null;
  className?: string;
};

/**
 * Shared public chrome for landing + catalogue.
 * Session-aware auth slot via Clerk <Show when="signed-in|signed-out">
 * (Clerk v6 renamed SignedIn/SignedOut → Show).
 * Auth slot has fixed min-width so swap never shifts layout.
 */
export function PublicHeader({
  maxWidthClass = "max-w-5xl",
  active = null,
  className,
}: PublicHeaderProps) {
  return (
    <header className={cn("border-b", className)}>
      <div
        className={cn(
          "mx-auto flex h-14 items-center justify-between gap-4 px-4",
          maxWidthClass,
        )}
      >
        <div className="flex min-w-0 items-center gap-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <BrandMark className="size-5" />
            Zevium
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
    </header>
  );
}
