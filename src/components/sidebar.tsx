import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams, useRouter } from "@tanstack/react-router";
import { atom, useAtom } from "jotai";
import {
  Building2,
  Check,
  ChevronDown,
  Database,
  DockIcon,
  LayoutDashboardIcon,
  LogIn,
  LogOut,
  Moon,
  Palette,
  Plus,
  Settings,
  Sun,
} from "lucide-react";
import { useEffect } from "react";

import { useTheme } from "~/components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { auth, useSession } from "~/lib/auth";
import { useTRPC } from "~/lib/trpc";

const headerContentAtom = atom<React.ReactNode>(null);

export const PageHeaderContent: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [, setHeaderContent] = useAtom(headerContentAtom);
  useEffect(() => {
    setHeaderContent(children);
  }, [children, setHeaderContent]);
  return null;
};

export function PageHeader() {
  const [headerContent] = useAtom(headerContentAtom);

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 backdrop-blur-xs transition-[width,height] ease-linear md:group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex w-full items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1 size-8" />
        {headerContent}
      </div>
    </header>
  );
}

const navData = [
  {
    icon: Settings,
    open: false,
    requiresAuth: true,
    subroutes: [
      { title: "Activity", url: "/app/settings/activity/$" },
      { title: "API Keys", url: "/app/settings/keys/$" },
      { title: "Credits", url: "/app/settings/credits/$" },
      { title: "Preferences", url: "/app/settings/preference/$" },
    ],
    title: "Settings",
    url: "/app/settings",
  },
];

interface OrganizationRoute {
  logo?: null | string;
  title: string;
  url: string;
}

const isRouteActive = (pathname: string, route: string) => pathname === route || pathname.startsWith(`${route}/`);
const isDashboardActive = (pathname: string) => pathname === "/app" || pathname === "/app/dashboard";

/**
 * Renders the authenticated app sidebar. Safe to SSR: the `/app` route loader
 * prefetches (await) the org list so the `useSuspenseQuery` below never
 * suspends during server render, which keeps the sidebar in the SSR output
 * and avoids a hydration mismatch / re-mount flash.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation();
  const orgParams = useParams({ from: "/app/organizations/$organizationSlug", shouldThrow: false });
  const projectParams = useParams({
    from: "/app/organizations/$organizationSlug/projects/$projectSlug/",
    shouldThrow: false,
  });
  const trpc = useTRPC();
  const user = useSession().user;
  const orgListQuery = useSuspenseQuery(trpc.organization.list.queryOptions(undefined, { enabled: !!user }));
  const selectedOrganizationSlug = orgParams?.organizationSlug;
  const activeOrganization = orgListQuery.data.find((org) => org.slug === orgParams?.organizationSlug);

  // Intentionally not using suspense for projects list cuz it causes hydration issues
  const projectsListQuery = useQuery(
    trpc.project.list.queryOptions(
      { organizationSlug: selectedOrganizationSlug },
      { enabled: !!selectedOrganizationSlug && !!user },
    ),
  );

  const orgNavData = {
    subroutes: orgListQuery.data.map((org) => ({
      logo: org.logo,
      title: org.name,
      url: `/app/organizations/${org.slug}`,
    })),
  };

  const projectNavData = selectedOrganizationSlug &&
    projectsListQuery.data && {
      icon: DockIcon,
      open: !projectParams?.projectSlug || undefined,
      requiresAuth: true,
      subroutes: projectsListQuery.data.map((project) => ({
        title: project.name,
        url: `/app/organizations/${selectedOrganizationSlug}/projects/${project.slug}`,
      })),
      title: "Projects",
      url: `/app/organizations/${selectedOrganizationSlug}/projects`,
    };

  const hasOrganizations = orgListQuery.data.length > 0;
  const needsOrganizationSelection = hasOrganizations && !selectedOrganizationSlug;
  const filteredNavData = [projectNavData, ...navData].filter(Boolean);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <OrganizationSelectorMenu
            organizationName={activeOrganization?.name}
            pathname={location.pathname}
            routes={orgNavData.subroutes}
          />
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                isActive={isDashboardActive(location.pathname)}
              >
                <Link to="/app">
                  <LayoutDashboardIcon />
                  <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                isActive={isRouteActive(location.pathname, "/app/catalogue")}
              >
                <Link to="/app/catalogue">
                  <Database />
                  <span>API Catalogue</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {needsOrganizationSelection ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                  isActive={location.pathname.startsWith("/app/organizations")}
                >
                  <Link to="/app/organizations/~">
                    <Building2 />
                    <span>Choose Organization</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}

            {!hasOrganizations ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                  isActive={location.pathname.startsWith("/app/organizations/create")}
                >
                  <Link to="/app/organizations/create">
                    <Plus />
                    <span>Create Organization</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}

            {filteredNavData.map((item) => {
              const isActive = isRouteActive(location.pathname, item.url);

              if (item.subroutes.length > 0) {
                return (
                  <Collapsible
                    className="group/collapsible"
                    defaultOpen={isActive || item.open}
                    key={`${item.title}-${isActive ? "active" : "inactive"}`}
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                          isActive={isActive}
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.subroutes.map((sub) => {
                            const isSubActive = isRouteActive(location.pathname, sub.url);
                            return (
                              <SidebarMenuSubItem key={sub.title}>
                                <SidebarMenuSubButton asChild isActive={isSubActive}>
                                  <Link to={sub.url}>{sub.title}</Link>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              }

              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                    isActive={isActive}
                  >
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {/* Theme Selector */}
          <SidebarMenuItem>
            <ThemeSelector />
          </SidebarMenuItem>
          {/* Account Section */}
          <SidebarMenuItem>
            <AccountSection />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function MainSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation();
  const orgParams = useParams({ from: "/app/organizations/$organizationSlug", shouldThrow: false });
  const user = useSession().user;
  const trpc = useTRPC();
  const orgListQuery = useQuery(trpc.organization.list.queryOptions(undefined, { enabled: !!user }));

  const orgNavData = user && {
    subroutes: (orgListQuery.data ?? []).map((org) => ({
      logo: org.logo,
      title: org.name,
      url: `/app/organizations/${org.slug}`,
    })),
  };
  const activeOrganization = orgListQuery.data?.find((org) => org.slug === orgParams?.organizationSlug);

  const filteredNavData = [...navData];

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          {user && orgNavData ? (
            <OrganizationSelectorMenu
              organizationName={activeOrganization?.name}
              pathname={location.pathname}
              routes={orgNavData.subroutes}
            />
          ) : (
            <SidebarMenuItem>
              <Link to="/">
                <SidebarMenuButton size="lg">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-full bg-black">
                    <img alt="zevium" className="size-7" src="/icon.png" />
                  </div>
                  <div className="grid flex-1 text-left text-sm/tight">
                    <span className="font-heading truncate">zevium.dev</span>
                    <span className="truncate text-xs">a place to share</span>
                  </div>
                </SidebarMenuButton>
              </Link>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                isActive={user ? isDashboardActive(location.pathname) : false}
              >
                <Link to={user ? "/app" : "/auth/sign-in"}>
                  <LayoutDashboardIcon />
                  <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                isActive={user ? isRouteActive(location.pathname, "/app/catalogue") : false}
              >
                <Link to={user ? "/app/catalogue" : "/auth/sign-in"}>
                  <Database />
                  <span>API Catalogue</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {user &&
              filteredNavData.map((item) => {
                const isActive = isRouteActive(location.pathname, item.url);

                if (item.subroutes.length > 0) {
                  return (
                    <Collapsible
                      className="group/collapsible"
                      defaultOpen={isActive || item.open}
                      key={`${item.title}-${isActive ? "active" : "inactive"}`}
                    >
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton
                            className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                            isActive={isActive}
                          >
                            <item.icon />
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {item.subroutes.map((sub) => {
                              const isSubActive = isRouteActive(location.pathname, sub.url);
                              return (
                                <SidebarMenuSubItem key={sub.title}>
                                  <SidebarMenuSubButton asChild isActive={isSubActive}>
                                    <Link to={sub.url}>{sub.title}</Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              );
                            })}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  );
                }

                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                      isActive={isActive}
                    >
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {/* Theme Selector */}
          <SidebarMenuItem>
            <ThemeSelector />
          </SidebarMenuItem>
          {/* Account Section */}
          <SidebarMenuItem>
            <AccountSection />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// Account Section Component
function AccountSection() {
  const queryClient = useQueryClient();
  const user = useSession().user;
  const { state } = useSidebar();
  const router = useRouter();

  const handleSignIn = async () => {
    await router.navigate({ to: "/auth/sign-in" });
    void queryClient.invalidateQueries();
  };

  const handleSignOut = async () => {
    await auth.signOut();
    void queryClient.invalidateQueries();
  };

  const getUserInitials = (u: NonNullable<typeof user>) => {
    return u.name.charAt(0) || u.email.charAt(0) || "U";
  };

  if (state === "collapsed") {
    if (user) {
      // Signed in - show avatar with dropdown
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="transition-colors group-data-[state=collapsed]:hover:bg-sidebar-accent group-data-[state=collapsed]:hover:text-sidebar-accent-foreground"
              size="default"
            >
              <Avatar className="-ml-1 size-6">
                <AvatarImage alt={user.name || "User"} src={user.image ?? ""} />
                <AvatarFallback className="text-xs">{getUserInitials(user)}</AvatarFallback>
              </Avatar>
              <span className="sr-only">Account menu</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="right" sideOffset={4}>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm leading-none font-medium">{user.name}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="mr-2 size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    } else {
      // Not signed in - show sign in icon
      return (
        <SidebarMenuButton
          className="transition-colors group-data-[state=collapsed]:hover:bg-sidebar-accent group-data-[state=collapsed]:hover:text-sidebar-accent-foreground"
          onClick={handleSignIn}
          size="default"
        >
          <LogIn className="size-4" />
          <span className="sr-only">Sign in</span>
        </SidebarMenuButton>
      );
    }
  }

  if (user) {
    // Signed in - show full profile with dropdown
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton className="transition-colors group-data-[state=expanded]:hover:bg-sidebar-accent group-data-[state=expanded]:hover:text-sidebar-accent-foreground">
            <Avatar className="-ml-1 size-6">
              <AvatarImage alt={user.name || "User"} src={user.image ?? ""} />
              <AvatarFallback className="text-xs">{getUserInitials(user)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm/tight">
              <span className="truncate font-medium">{user.name}</span>
            </div>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" sideOffset={4}>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm leading-none font-medium">{user.name}</p>
              <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut}>
            <LogOut className="mr-2 size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else {
    // Not signed in - show sign in button
    return (
      <SidebarMenuButton
        className="transition-colors group-data-[state=expanded]:hover:bg-sidebar-accent group-data-[state=expanded]:hover:text-sidebar-accent-foreground"
        onClick={handleSignIn}
      >
        <LogIn className="size-4" />
        <span className="font-medium">Sign in</span>
      </SidebarMenuButton>
    );
  }
}

function OrganizationSelectorMenu({
  organizationName,
  pathname,
  routes,
}: {
  organizationName?: string;
  pathname: string;
  routes: Array<OrganizationRoute>;
}) {
  const router = useRouter();
  const hasOrganizations = routes.length > 0;
  const organizationOptions = routes;
  const selectedOrganization = organizationOptions.find(
    (route) => pathname === route.url || pathname.startsWith(`${route.url}/`),
  );
  const selectedValue = selectedOrganization?.url;
  const triggerLabel =
    organizationName ??
    selectedOrganization?.title ??
    (hasOrganizations ? "Choose organization" : "Create organization");

  const handleNavigation = (url: string) => {
    void router.navigate({ to: url });
  };

  const getOrganizationInitials = (name: string) => {
    const initials = name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("");

    return initials || "O";
  };

  return (
    <SidebarMenuItem>
      <div className="flex h-12 items-center gap-2 overflow-hidden rounded-md p-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
        <div className="flex aspect-square size-8 items-center justify-center rounded-full bg-black">
          <img alt="zevium" className="size-7" src="/icon.png" />
        </div>
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-8 w-full items-center justify-between gap-2 rounded-md border-none bg-transparent p-0 text-left text-sm shadow-none transition-colors outline-none hover:text-sidebar-accent-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="truncate">{triggerLabel}</span>
                </span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {hasOrganizations ? (
                <>
                  {organizationOptions.map((route) => {
                    const isSelected = route.url === selectedValue;

                    return (
                      <DropdownMenuItem
                        className="w-full justify-start px-2 text-left"
                        key={route.url}
                        onClick={() => handleNavigation(route.url)}
                      >
                        <Avatar className="size-5 border border-border/60">
                          <AvatarImage alt={route.title} src={route.logo ?? ""} />
                          <AvatarFallback className="text-[10px]">
                            {getOrganizationInitials(route.title)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate text-left">{route.title}</span>
                        {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="w-full justify-start px-2 text-left"
                    onClick={() => handleNavigation("/app/organizations/~")}
                  >
                    <Building2 className="size-4" />
                    <span className="flex-1 text-left">All organizations</span>
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem
                  className="w-full justify-start px-2 text-left"
                  onClick={() => handleNavigation("/app/organizations/create")}
                >
                  <Plus className="size-4" />
                  <span className="flex-1 text-left">Create organization</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </SidebarMenuItem>
  );
}

// Theme Selector Component
function ThemeSelector() {
  const { setTheme, theme } = useTheme();
  const { state } = useSidebar();
  const themeCycle = ["system", "dark", "light"] as const;

  const currentTheme =
    theme === "dark"
      ? { Icon: Moon, label: "Dark" }
      : theme === "light"
        ? { Icon: Sun, label: "Light" }
        : { Icon: Palette, label: "System" };

  const toggleTheme = () => {
    const currentIndex = themeCycle.indexOf(theme);
    const nextTheme = themeCycle[(currentIndex + 1) % themeCycle.length] ?? "system";
    setTheme(nextTheme);
  };

  if (state === "collapsed") {
    return (
      <SidebarMenuButton
        className="transition-colors group-data-[state=collapsed]:hover:bg-sidebar-accent group-data-[state=collapsed]:hover:text-sidebar-accent-foreground"
        onClick={toggleTheme}
        size="default"
      >
        <currentTheme.Icon className="size-4 transition-all" />
        <span className="sr-only">Cycle theme, current: {currentTheme.label}</span>
      </SidebarMenuButton>
    );
  }

  return (
    <SidebarMenuButton
      className="transition-colors group-data-[state=expanded]:hover:bg-sidebar-accent group-data-[state=expanded]:hover:text-sidebar-accent-foreground"
      onClick={toggleTheme}
    >
      <currentTheme.Icon className="size-4 transition-all" />
      <span className="font-medium">{currentTheme.label}</span>
    </SidebarMenuButton>
  );
}
