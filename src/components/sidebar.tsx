import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useMatches, useParams, useRouter } from "@tanstack/react-router";
import { atom, useAtom } from "jotai";
import {
  Building2Icon,
  Database,
  DockIcon,
  LayoutDashboardIcon,
  LogIn,
  LogOut,
  Moon,
  Palette,
  Settings,
  Sun,
} from "lucide-react";
import * as React from "react";

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
import { auth, useUser } from "~/lib/auth";
import { useTRPC } from "~/lib/trpc";

const headerContentAtom = atom<React.ReactNode>(null);

export const PageHeaderContent: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [, setHeaderContent] = useAtom(headerContentAtom);
  React.useEffect(() => {
    setHeaderContent(children);
  }, [children, setHeaderContent]);
  return null;
};

export function PageHeader() {
  const [headerContent] = useAtom(headerContentAtom);

  return (
    <header
      className={`
      sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 backdrop-blur-xs
      transition-[width,height] ease-linear
      group-has-data-[collapsible=icon]/sidebar-wrapper:h-12
    `}
    >
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

/** Must be wrapped in a ClientOnly cuz of hydration issues */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const [, match] = useMatches();
  const params = useParams({ from: "/app/organizations/$organizationSlug", shouldThrow: false });
  const trpc = useTRPC();
  const user = useUser();
  // Intentionally not using suspense for projects list cuz it causes hydration issues
  const projectsListQuery = useQuery(
    trpc.project.list.queryOptions(
      { organizationSlug: params?.organizationSlug },
      { enabled: !!params?.organizationSlug && !!user },
    ),
  );
  const orgListQuery = useSuspenseQuery(trpc.organization.list.queryOptions(undefined, { enabled: !!user }));

  const orgNavData = {
    icon: Building2Icon,
    requiresAuth: true,
    subroutes: orgListQuery.data.map((org) => ({
      title: org.name,
      url: `/app/organizations/${org.slug}`,
    })),
    title: "Organizations",
    url: "/app/organizations/~",
  };

  const projectNavData = projectsListQuery.data && {
    icon: DockIcon,
    requiresAuth: true,
    subroutes: projectsListQuery.data.map((project) => ({
      title: project.name,
      url: `/app/organizations/${params?.organizationSlug}/projects/${project.slug}`,
    })),
    title: "Projects",
    url: `/app/organizations/${params?.organizationSlug}/projects`,
  };

  const filteredNavData = [orgNavData, projectNavData, ...navData].filter(Boolean);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <Link to="/">
              <SidebarMenuButton size="lg">
                <div
                  className={`
                  flex aspect-square size-8 items-center justify-center
                  rounded-full bg-black
                `}
                >
                  <img alt="zevium" className="size-7" src="/icon.png" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="font-heading truncate">zevium.dev</span>
                  <span className="truncate text-xs">a place to share</span>
                </div>
              </SidebarMenuButton>
            </Link>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={`
                data-[active=true]:bg-main
                data-[active=true]:text-main-foreground
              `}
              >
                <Link to="/app/dashboard">
                  <LayoutDashboardIcon />
                  <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={`
                data-[active=true]:bg-main
                data-[active=true]:text-main-foreground
              `}
              >
                <Link to="/app/catalogue">
                  <Database />
                  <span>API Catalogue</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {filteredNavData.map((item) => {
              if (!match) return <React.Fragment key={item.title} />;

              // Check if current path matches the item URL or starts with it (for nested routes)
              const isActive = match.pathname === item.url || (item.url !== "/" && match.pathname.startsWith(item.url));

              // Collapsible Settings item with subroutes
              if (item.subroutes.length > 0) {
                const isSettingsActive = match.pathname.startsWith("/settings");

                return (
                  <Collapsible className="group/collapsible" defaultOpen={isSettingsActive} key={item.title}>
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          className={`
                            data-[active=true]:bg-main
                            data-[active=true]:text-main-foreground
                          `}
                          isActive={isSettingsActive}
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.subroutes.map((sub) => {
                            const isSubActive = match.pathname === sub.url || match.pathname.startsWith(sub.url + "/");
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
                    className={`
                      data-[active=true]:bg-main
                      data-[active=true]:text-main-foreground
                    `}
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
  const user = useUser();
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <Link to="/">
              <SidebarMenuButton size="lg">
                <div
                  className={`
                  flex aspect-square size-8 items-center justify-center
                  rounded-full bg-black
                `}
                >
                  <img alt="zevium" className="size-7" src="/icon.png" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="font-heading truncate">zevium.dev</span>
                  <span className="truncate text-xs">a place to share</span>
                </div>
              </SidebarMenuButton>
            </Link>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={`
                data-[active=true]:bg-main
                data-[active=true]:text-main-foreground
              `}
              >
                <Link to={user ? "/app/dashboard" : "/auth/sign-in"}>
                  <LayoutDashboardIcon />
                  <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={`
                data-[active=true]:bg-main
                data-[active=true]:text-main-foreground
              `}
              >
                <Link to={user ? "/app/catalogue" : "/auth/sign-in"}>
                  <Database />
                  <span>API Catalogue</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
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
  const user = useUser();
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
              className={`
                transition-colors
                group-data-[state=collapsed]:hover:bg-sidebar-accent
                group-data-[state=collapsed]:hover:text-sidebar-accent-foreground
              `}
              size="default"
            >
              <Avatar className="size-6">
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
      // Not signed in - show sign in icon
      return (
        <SidebarMenuButton
          className={`
            transition-colors
            group-data-[state=collapsed]:hover:bg-sidebar-accent
            group-data-[state=collapsed]:hover:text-sidebar-accent-foreground
          `}
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
          <SidebarMenuButton
            className={`
            transition-colors
            group-data-[state=expanded]:hover:bg-sidebar-accent
            group-data-[state=expanded]:hover:text-sidebar-accent-foreground
          `}
          >
            <Avatar className="size-6">
              <AvatarImage alt={user.name || "User"} src={user.image ?? ""} />
              <AvatarFallback className="text-xs">{getUserInitials(user)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
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
        className={`
          transition-colors
          group-data-[state=expanded]:hover:bg-sidebar-accent
          group-data-[state=expanded]:hover:text-sidebar-accent-foreground
        `}
        onClick={handleSignIn}
      >
        <LogIn className="size-4" />
        <span className="font-medium">Sign in</span>
      </SidebarMenuButton>
    );
  }
}

// Theme Selector Component
function ThemeSelector() {
  const { setTheme } = useTheme();
  const { state } = useSidebar();

  if (state === "collapsed") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            className={`
              transition-colors
              group-data-[state=collapsed]:hover:bg-sidebar-accent
              group-data-[state=collapsed]:hover:text-sidebar-accent-foreground
            `}
            size="default"
          >
            <Sun
              className={`
              size-4 scale-100 rotate-0 transition-all
              dark:scale-0 dark:-rotate-90
            `}
            />
            <Moon
              className={`
              absolute size-4 scale-0 rotate-90 transition-all
              dark:scale-100 dark:rotate-0
            `}
            />
            <span className="sr-only">Toggle theme</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="right" sideOffset={4}>
          <DropdownMenuItem onClick={() => setTheme("light")}>
            <Sun className="mr-2 size-4" />
            Light
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("dark")}>
            <Moon className="mr-2 size-4" />
            Dark
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("system")}>
            <Palette className="mr-2 size-4" />
            System
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          className={`
          transition-colors
          group-data-[state=expanded]:hover:bg-sidebar-accent
          group-data-[state=expanded]:hover:text-sidebar-accent-foreground
        `}
        >
          <Sun
            className={`
            size-4 scale-100 rotate-0 transition-all
            dark:scale-0 dark:-rotate-90
          `}
          />
          <span
            className={`
            font-medium opacity-100
            dark:opacity-0
          `}
          >
            Light
          </span>
          <Moon
            className={`
            absolute size-4 scale-0 rotate-90 transition-all
            dark:scale-100 dark:rotate-0
          `}
          />
          <span
            className={`
            absolute ml-6 font-medium opacity-0
            dark:opacity-100
          `}
          >
            Dark
          </span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" sideOffset={4}>
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 size-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 size-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Palette className="mr-2 size-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
