import { Link } from "@tanstack/react-router";

import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

const NAV: { to: string; label: string }[] = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/orgs", label: "Orgs" },
  { to: "/admin/projects", label: "Projects" },
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
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <BrandMark className="size-5" />
        Zevium Admin
      </span>
      <nav className="ml-4 hidden items-center gap-0.5 sm:flex">
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
