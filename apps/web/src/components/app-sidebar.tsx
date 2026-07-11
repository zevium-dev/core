import { OrganizationSwitcher, UserButton } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  CreditCard,
  FolderKanban,
  LayoutDashboard,
  Settings,
} from "lucide-react";

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
} from "#/components/ui/sidebar";

const navItems = [
  { title: "Dashboard", to: "/app", icon: LayoutDashboard, exact: true },
  { title: "Catalogue", to: "/catalogue", icon: BookOpen, exact: false },
  { title: "Projects", to: "/app/projects", icon: FolderKanban, exact: false },
  { title: "Billing", to: "/app/billing", icon: CreditCard, exact: false },
  { title: "Settings", to: "/app/settings", icon: Settings, exact: false },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold">
            Z
          </div>
          <span className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Zevium
          </span>
        </div>
        <div className="px-1 group-data-[collapsible=icon]:hidden">
          <OrganizationSwitcher
            appearance={{ theme: shadcn }}
            afterSelectOrganizationUrl="/app"
            afterCreateOrganizationUrl="/app"
            hidePersonal={false}
          />
        </div>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const active = item.exact
                  ? pathname === item.to
                  : pathname === item.to || pathname.startsWith(`${item.to}/`);
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
      </SidebarContent>

      <SidebarFooter className="gap-2 p-3">
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col">
          <ThemeToggle />
          <UserButton appearance={{ theme: shadcn }} />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
