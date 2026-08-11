import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState } from "react";

import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet";
import { cn } from "#/lib/utils";

const NAV: { to: string; label: string }[] = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/orgs", label: "Orgs" },
  { to: "/admin/projects", label: "Projects" },
  { to: "/admin/payouts", label: "Payouts" },
];

const navLinkClass =
  "rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground transition-[color,background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground";

export function AdminHeader() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <Link
        to="/admin"
        aria-label="Zevium Admin"
        className="flex items-center gap-0.5 rounded-md text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <BrandMark className="h-3 w-4" />
        <span aria-hidden="true">evium Admin</span>
      </Link>
      <nav
        className="ml-4 hidden items-center gap-0.5 sm:flex"
        aria-label="Admin"
      >
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(navLinkClass, "data-[status=active]:text-foreground")}
            activeProps={{
              "data-status": "active",
              "aria-current": "page",
            }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <Button asChild variant="ghost" size="sm">
          <Link to="/app">Back to app</Link>
        </Button>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="sm:hidden"
              aria-label="Open admin navigation"
            >
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72">
            <SheetHeader>
              <SheetTitle>Admin navigation</SheetTitle>
              <SheetDescription>
                Platform operations and marketplace controls.
              </SheetDescription>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-3" aria-label="Admin">
              {NAV.map((item) => {
                const active =
                  item.to === "/admin"
                    ? pathname === item.to
                    : pathname.startsWith(`${item.to}/`) ||
                      pathname === item.to;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-md px-3 py-2 text-sm font-medium outline-none transition-[color,background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground",
                    )}
                    onClick={() => setMobileOpen(false)}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
