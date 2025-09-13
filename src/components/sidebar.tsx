import { Link, useMatches } from "@tanstack/react-router";
import { atom, useAtom } from "jotai";
import { Building2Icon, Database, DockIcon, HomeIcon, LogIn, LogOut, Moon, Palette, Sun, Settings } from "lucide-react";
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
import { auth } from "~/lib/auth";

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
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 backdrop-blur-xs transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
      <div className="flex w-full items-center justify-between gap-2 px-4">
        <SidebarTrigger className="-ml-1 size-8" />
        {headerContent}
      </div>
    </header>
  );
}

const navData = [
  {
    icon: HomeIcon,
    requiresAuth: false,
    title: "Home",
    url: "/",
  },
  {
    icon: Database,
    requiresAuth: false,
    title: "API Catalogue",
    url: "/catalogue",
  },
  {
    icon: Building2Icon,
    requiresAuth: true,
    title: "Organizations",
    url: "/organizations",
  },
  {
    icon: DockIcon,
    requiresAuth: true,
    title: "Projects",
    url: "/projects",
  },
  {
    icon: Settings,
    requiresAuth: false,
    title: "Settings",
    url: "/settings",
    subroutes: [
      { title: "Activity", url: "/settings/activity/$" },
      { title: "API Keys", url: "/settings/keys/$" },
      { title: "Credits", url: "/settings/credits/$" },
      { title: "Preferences", url: "/settings/preference/$" },
    ],
  },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const [, match] = useMatches();
  const authState = auth.useSession();

  // Filter navigation items based on authentication state
  const filteredNavData = navData.filter((item) => {
    if (item.requiresAuth) {
      return authState.data?.user;
    }
    return true;
  });

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <Link to="/">
              <SidebarMenuButton size="lg">
                <div className="flex aspect-square size-8 items-center justify-center rounded-full bg-black">
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
            {filteredNavData.map((item) => {
              // Check if current path matches the item URL or starts with it (for nested routes)
              const isActive = match.pathname === item.url || (item.url !== "/" && match.pathname.startsWith(item.url));

              // Collapsible Settings item with subroutes
              if (item.title === "Settings" && item.subroutes) {
                const isSettingsActive = match.pathname.startsWith("/settings");

                return (
                  <Collapsible defaultOpen={isSettingsActive} key={item.title} className="group/collapsible">
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton className="data-[active=true]:bg-main data-[active=true]:text-main-foreground" isActive={isSettingsActive}>
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
  const authState = auth.useSession();
  const { state } = useSidebar();

  const handleSignIn = async () => {
    await auth.signIn.social({ provider: "google" });
  };

  const handleSignOut = async () => {
    await auth.signOut();
  };

  const getUserInitials = (user: NonNullable<typeof authState.data>["user"]) => {
    return user.name.charAt(0) || user.email.charAt(0) || "U";
  };

  if (state === "collapsed") {
    if (authState.data?.user) {
      // Signed in - show avatar with dropdown
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="group-data-[state=collapsed]:hover:bg-sidebar-accent group-data-[state=collapsed]:hover:text-sidebar-accent-foreground transition-colors"
              size="default"
            >
              <Avatar className="size-6">
                <AvatarImage alt={authState.data.user.name || "User"} src={authState.data.user.image ?? ""} />
                <AvatarFallback className="text-xs">{getUserInitials(authState.data.user)}</AvatarFallback>
              </Avatar>
              <span className="sr-only">Account menu</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="right" sideOffset={4}>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm leading-none font-medium">{authState.data.user.name}</p>
                <p className="text-muted-foreground text-xs leading-none">{authState.data.user.email}</p>
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
          className="group-data-[state=collapsed]:hover:bg-sidebar-accent group-data-[state=collapsed]:hover:text-sidebar-accent-foreground transition-colors"
          disabled={authState.isPending}
          onClick={handleSignIn}
          size="default"
        >
          <LogIn className="size-4" />
          <span className="sr-only">Sign in</span>
        </SidebarMenuButton>
      );
    }
  }

  if (authState.data?.user) {
    // Signed in - show full profile with dropdown
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton className="group-data-[state=expanded]:hover:bg-sidebar-accent group-data-[state=expanded]:hover:text-sidebar-accent-foreground transition-colors">
            <Avatar className="size-6">
              <AvatarImage alt={authState.data.user.name || "User"} src={authState.data.user.image ?? ""} />
              <AvatarFallback className="text-xs">{getUserInitials(authState.data.user)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{authState.data.user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{authState.data.user.email}</span>
            </div>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" sideOffset={4}>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm leading-none font-medium">{authState.data.user.name}</p>
              <p className="text-muted-foreground text-xs leading-none">{authState.data.user.email}</p>
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
        className="group-data-[state=expanded]:hover:bg-sidebar-accent group-data-[state=expanded]:hover:text-sidebar-accent-foreground transition-colors"
        disabled={authState.isPending}
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
            className="group-data-[state=collapsed]:hover:bg-sidebar-accent group-data-[state=collapsed]:hover:text-sidebar-accent-foreground transition-colors"
            size="default"
          >
            <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
            <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
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
        <SidebarMenuButton className="group-data-[state=expanded]:hover:bg-sidebar-accent group-data-[state=expanded]:hover:text-sidebar-accent-foreground transition-colors">
          <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <span className="font-medium opacity-100 dark:opacity-0">Light</span>
          <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="absolute ml-6 font-medium opacity-0 dark:opacity-100">Dark</span>
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
