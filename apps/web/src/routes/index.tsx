import { Link, createFileRoute } from "@tanstack/react-router";
import { m, useReducedMotion } from "motion/react";

import { ThemeToggle } from "#/components/theme-toggle";
import { Button } from "#/components/ui/button";
import { DIST, DUR, EASE, STAGGER } from "#/lib/motion";
import { vtState } from "#/lib/vt";

export const Route = createFileRoute("/")({
  component: LandingPage,
  head: () => ({
    meta: [
      { title: "Zevium — Agent-first API marketplace" },
      {
        name: "description",
        content:
          "Publish OpenAPI specs, price per call, and let humans and agents pay with prepaid credits.",
      },
    ],
  }),
});

function LandingPage() {
  const reduce = useReducedMotion();
  const skipEnter = reduce || vtState.active;

  const item = {
    hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: DUR.slow, ease: EASE },
    },
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <span className="text-sm font-semibold tracking-tight">Zevium</span>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/catalogue">Catalogue</Link>
            </Button>
            <ThemeToggle />
            <Button asChild variant="outline" size="sm">
              <Link to="/sign-in/$">Sign in</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col px-4 py-20 sm:py-28">
        <m.div
          className="flex max-w-2xl flex-col gap-6"
          initial="hidden"
          animate="show"
          variants={{
            show: {
              transition: { staggerChildren: reduce ? 0 : 0.15 },
            },
          }}
        >
          <m.h1
            className="text-4xl font-semibold tracking-tight sm:text-5xl"
            variants={item}
          >
            Agent-first API marketplace
          </m.h1>
          <m.p
            className="text-lg text-muted-foreground"
            variants={item}
          >
            Publishers list OpenAPI specs with per-call pricing. Consumers and
            agents prepay credits and hit a metered edge gateway. Publishers keep
            95%.
          </m.p>
          <m.div className="flex flex-wrap items-center gap-3" variants={item}>
            <Button asChild size="lg">
              <Link
                to="/catalogue"
                style={{ viewTransitionName: "catalogue-heading" }}
              >
                Browse catalogue
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/sign-up/$">Get started</Link>
            </Button>
          </m.div>
          <m.p
            className="text-sm text-muted-foreground"
            variants={{
              hidden: skipEnter
                ? { opacity: 1, y: 0 }
                : { opacity: 0, y: DIST },
              show: {
                opacity: 1,
                y: 0,
                transition: {
                  duration: DUR.slow,
                  ease: EASE,
                  delay: reduce ? 0 : STAGGER,
                },
              },
            }}
          >
            Zero balance blocks the call. No surprise overages.
          </m.p>
        </m.div>
      </main>
    </div>
  );
}
