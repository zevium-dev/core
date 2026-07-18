import { OrganizationSwitcher, UserButton } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Banknote,
  BookOpen,
  BookText,
  Building2,
  CreditCard,
  FolderKanban,
  LayoutDashboard,
  Settings,
} from "lucide-react";

import { BrandMark } from "#/components/brand-mark";
import { ThemeToggle } from "#/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "#/components/ui/sidebar";

const navGroups = [
  {
    label: "Build",
    items: [
      { title: "Dashboard", to: "/app", icon: LayoutDashboard, exact: true },
      { title: "Catalogue", to: "/catalogue", icon: BookOpen, exact: false },
      {
        title: "Projects",
        to: "/app/projects",
        icon: FolderKanban,
        exact: false,
      },
    ],
  },
  {
    label: "Manage",
    items: [
      { title: "Organization", to: "/app/org", icon: Building2, exact: false },
      { title: "Billing", to: "/app/billing", icon: CreditCard, exact: false },
      { title: "Earnings", to: "/app/earnings", icon: Banknote, exact: false },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Settings", to: "/app/settings", icon: Settings, exact: false },
      { title: "Docs", to: "/docs", icon: BookText, exact: false },
    ],
  },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isMobile, state } = useSidebar();
  const compact = state === "collapsed" && !isMobile;

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="h-14 justify-center border-b p-3">
        <div className="flex items-center gap-1 px-1 transition-transform duration-[var(--dur-base)] ease-[var(--ease)] group-data-[collapsible=icon]:-translate-x-1">
          <BrandMark className="h-4 w-6 shrink-0" />
          <span className="truncate text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            <span className="sr-only">Z</span>evium
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <OrganizationSwitcher
              key={compact ? "compact" : "expanded"}
              appearance={{
                theme: shadcn,
                elements: {
                  rootBox: "flex! w-full! min-w-0",
                  organizationSwitcherTrigger: compact
                    ? "size-8! justify-center! overflow-hidden p-0!"
                    : "h-8! w-full! max-w-full min-w-0 justify-between overflow-hidden px-2!",
                  organizationPreview: compact
                    ? "w-full! justify-center! overflow-hidden"
                    : "min-w-0 flex-1 overflow-hidden",
                  organizationPreviewTextContainer: compact
                    ? "hidden!"
                    : "min-w-0",
                  organizationPreviewMainIdentifier: compact
                    ? "hidden!"
                    : "block truncate",
                  organizationSwitcherTriggerIcon: compact
                    ? "hidden!"
                    : "shrink-0",
                },
              }}
              afterSelectOrganizationUrl="/app"
              afterCreateOrganizationUrl="/app"
              hidePersonal={false}
            />
          </SidebarGroupContent>
        </SidebarGroup>

        {navGroups.map((group) => (
          <SidebarGroup key={group.label} className="py-0">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = item.exact
                    ? pathname === item.to
                    : pathname === item.to ||
                      pathname.startsWith(`${item.to}/`);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.title}
                      >
                        <Link to={item.to}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarSeparator className="w-[calc(100%-1rem)]!" />
      <SidebarFooter className="p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex min-w-0 items-center gap-2 rounded-md p-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
              <UserButton
                key={compact ? "compact" : "expanded"}
                showName={!compact}
                appearance={{
                  theme: shadcn,
                  elements: {
                    rootBox: "flex! min-w-0 flex-1",
                    userButtonTrigger: "w-full! min-w-0",
                    userButtonBox: compact
                      ? "w-full! justify-center!"
                      : "w-full! min-w-0 justify-start! gap-2!",
                    userButtonOuterIdentifier:
                      "order-2! min-w-0 flex-1 truncate text-left text-sm",
                    avatarBox: "order-1! size-7 shrink-0",
                  },
                }}
              />
              {compact ? null : (
                <ThemeToggle className="size-8 shrink-0" />
              )}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
