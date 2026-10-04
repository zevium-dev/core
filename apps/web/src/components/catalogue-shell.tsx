import { createContext, useContext, type ReactNode } from "react";

import { PublicHeader } from "#/components/public-header";
import { cn } from "#/lib/utils";

const CatalogueScope = createContext(false);

export function useCatalogueLinks() {
  const inApp = useContext(CatalogueScope);
  return {
    catalogue: inApp ? ("/app/catalogue" as const) : ("/catalogue" as const),
    detail: inApp
      ? ("/app/catalogue/$publisherHandle/$projectSlug" as const)
      : ("/catalogue/$publisherHandle/$projectSlug" as const),
    publish: inApp ? ("/app/projects" as const) : ("/sign-in/$" as const),
  };
}

/** App routes already own the header, main landmark, and page padding. */
export function CatalogueShell({
  inApp = false,
  children,
  pending = false,
}: {
  inApp?: boolean;
  children: ReactNode;
  pending?: boolean;
}) {
  return (
    <CatalogueScope.Provider value={inApp}>
      {inApp ? (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {children}
        </div>
      ) : (
        <div className="min-h-screen bg-background">
          <PublicHeader active="catalogue" />
          <main
            id="main-content"
            style={{ viewTransitionName: "main-content" }}
            tabIndex={-1}
            className={cn(
              "mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 outline-none",
              !pending && "content-enter",
            )}
          >
            {children}
          </main>
        </div>
      )}
    </CatalogueScope.Provider>
  );
}
