import { Link } from "@tanstack/react-router";

import { AccountButton } from "./account-button";
import { ModeToggle } from "./theme-toggle";

export function TopNav() {
  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link className="text-foreground flex items-center gap-2" to="/">
            <img alt="Zevium" className="size-6" src="/logo.svg" />
            <span className="font-medium">zevium.dev</span>
          </Link>
          <Link className="text-muted-foreground hover:text-foreground text-sm transition-colors" to="/">
            Categories
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <ModeToggle />
          <AccountButton />
        </div>
      </div>
    </header>
  );
}
