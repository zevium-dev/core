import { Link, useMatches } from "@tanstack/react-router";
import { atom, useAtom } from "jotai";
import { Database, HomeIcon } from "lucide-react";
import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";

import { AccountButton } from "./account-button";
import { ModeToggle } from "./theme-toggle";

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
    title: "Home",
    url: "/",
  },
  {
    icon: Database,
    title: "API Catalogue",
    url: "/catalogue",
  },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { isMobile } = useSidebar();
  const [, match] = useMatches();

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
          <SidebarGroupLabel>About me</SidebarGroupLabel>
          <SidebarMenu>
            {navData.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  className="data-[active=true]:bg-main data-[active=true]:text-main-foreground"
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                  isActive={match?.pathname === item.url}
                >
                  <Link to={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  className="overflow-visible group-data-[state=collapsed]:hover:bg-transparent group-data-[state=collapsed]:hover:outline-0"
                  size="lg"
                >
                  <Avatar className="h-8 w-8">
                    <AvatarImage alt="zevium" src="/icon.png" />
                    <AvatarFallback>Z</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="font-heading truncate">Signed In user</span>
                    <span className="truncate text-xs">Placeholder</span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
                side={isMobile ? "bottom" : "right"}
                sideOffset={4}
              >
                <DropdownMenuLabel className="font-base p-0">
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                    <AccountButton />
                    <ModeToggle />
                  </div>
                </DropdownMenuLabel>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
