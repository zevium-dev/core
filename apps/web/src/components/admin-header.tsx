import { Link } from "@tanstack/react-router";

import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

const NAV: { to: string; label: string }[] = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/orgs", label: "Orgs" },
  { to: "/admin/projects", label: "Projects" },
  { to: "/admin/reviews", label: "Reviews" },
  { to: "/admin/payouts", label: "Payouts" },
];

const navLinkClass =
  "rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground transition-[color,background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground";

/**
 * Minimal top bar for the platform admin shell.
 * No app sidebar, no org switcher — desktop-first staff surface.
 */
export function AdminHeader() {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 sm:flex-nowrap sm:py-0">
      <Link
        to="/admin"
        aria-label="Zevium Admin"
        className="flex items-center gap-0.5 rounded-md text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <BrandMark className="h-3 w-4" />
        <span aria-hidden="true">evium Admin</span>
      </Link>
      <nav
        aria-label="Admin sections"
        className="order-3 flex w-full items-center gap-0.5 overflow-x-auto sm:order-none sm:ml-4 sm:w-auto"
      >
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(navLinkClass, "data-[status=active]:text-foreground")}
            activeProps={{ "data-status": "active" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto">
        <Button asChild variant="ghost" size="sm">
          <Link to="/app">Back to app</Link>
        </Button>
      </div>
    </header>
  );
}
