import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PublicHeader } from "#/components/public-header";
import { Button } from "#/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet";
import { cn } from "#/lib/utils";

/**
 * Docs section nav. `as const` gives literal `to` types so TanStack <Link>
 * typechecks against the registered route union (after route-tree regen).
 */
export const DOCS_SECTIONS = [
  { label: "Getting started", to: "/docs" },
  { label: "Publishing", to: "/docs/publishing" },
  { label: "Consuming", to: "/docs/consuming" },
  { label: "Agents", to: "/docs/agents" },
] as const;

/**
 * Prose tuned to semantic tokens so dark+light both read first-class.
 * No raw Tailwind colors leak (DESIGN.md); @tailwindcss/typography modifiers
 * remap every typography var onto the shadcn token scale.
 */
const PROSE_CLASS = cn(
  "prose max-w-none",
  "prose-headings:text-foreground prose-headings:font-semibold prose-headings:tracking-tight",
  "prose-h2:mt-10 prose-h2:border-b prose-h2:border-border prose-h2:pb-2",
  "prose-p:text-muted-foreground prose-p:leading-relaxed",
  "prose-strong:text-foreground",
  "prose-a:text-primary",
  "prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-code:font-mono",
  "prose-blockquote:border-l-border prose-blockquote:text-muted-foreground",
  "prose-hr:border-border",
  "prose-li:text-muted-foreground prose-li:marker:text-muted-foreground",
  "prose-lead:text-muted-foreground",
);

type DocsPageProps = {
  title: string;
  description: string;
  children: ReactNode;
};

/** Shared layout for every /docs page: header + collapsible sidebar + prose. */
export function DocsPage({ title, description, children }: DocsPageProps) {
  return (
    <div className="min-h-screen bg-background">
      <PublicHeader maxWidthClass="max-w-6xl" active="docs" />
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid gap-8 py-8 md:grid-cols-[14rem_minmax(0,1fr)]">
          <DocsSidebar />
          <article className={cn("content-enter min-w-0", PROSE_CLASS)}>
            <h1 className="mb-2">{title}</h1>
            <p className="lead mb-8">{description}</p>
            {children}
          </article>
        </div>
      </div>
    </div>
  );
}

function DocsSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);

  return (
    <>
      <aside className="hidden md:block">
        <nav className="sticky top-20 flex flex-col gap-1">
          <DocsNavList pathname={pathname} onNavigate={() => setOpen(false)} />
        </nav>
      </aside>

      <div className="md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <Menu className="size-4" />
              Contents
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-64 p-0"
          >
            <SheetHeader className="px-4 pt-4">
              <SheetTitle>Docs</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-3 py-2">
              <DocsNavList
                pathname={pathname}
                onNavigate={() => setOpen(false)}
              />
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

function DocsNavList({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <>
      <span className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Documentation
      </span>
      {DOCS_SECTIONS.map((section) => {
        const active = pathname === section.to;
        return (
          <Link
            key={section.to}
            to={section.to}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]",
              active
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </>
  );
}
