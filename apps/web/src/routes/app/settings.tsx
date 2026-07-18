import {
  Link,
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";

import { cn } from "#/lib/utils";

export const Route = createFileRoute("/app/settings")({
  component: SettingsLayout,
});

const tabs = [
  { title: "Account", to: "/app/settings", exact: true },
  { title: "Gateway keys", to: "/app/settings/keys", exact: false },
  { title: "Activity", to: "/app/settings/activity", exact: false },
] as const;

function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Account, gateway keys, and organization activity.
        </p>
      </div>
      <nav
        className="flex flex-wrap gap-1 border-b pb-px"
        aria-label="Settings sections"
      >
        {tabs.map((tab) => {
          const active = tab.exact
            ? pathname === tab.to || pathname === `${tab.to}/`
            : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={cn(
                "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.title}
              {active ? (
                <span
                  className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary"
                  aria-hidden
                />
              ) : null}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </div>
  );
}
