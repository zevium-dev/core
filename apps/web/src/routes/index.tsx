import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { m, useReducedMotion } from "motion/react";

import { Magnetic } from "#/components/motion/magnetic";
import { NumberTicker } from "#/components/motion/number-ticker";
import { PublicHeader } from "#/components/public-header";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { DIST, DUR, EASE, STAGGER } from "#/lib/motion";
import { vtState } from "#/lib/vt";

/** Static teaser when catalogue empty / query pending — never blank right half. */
const FALLBACK_TEASERS = [
  {
    name: "Weather",
    slug: "weather",
    orgSlug: "demo",
    orgName: "Demo",
    description: "Forecasts priced per call.",
  },
  {
    name: "FX Rates",
    slug: "fx-rates",
    orgSlug: "demo",
    orgName: "Demo",
    description: "Live FX with free tier on /ping.",
  },
  {
    name: "Embeddings",
    slug: "embeddings",
    orgSlug: "demo",
    orgName: "Demo",
    description: "Vectorize text. Agent-ready.",
  },
] as const;

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    // Prefetch public catalogue for hero teaser; ignore failures (static fallback).
    try {
      await context.queryClient.ensureQueryData(
        convexQuery(api.catalogue.listPublic, {}),
      );
    } catch {
      /* empty catalogue / offline — FALLBACK_TEASERS */
    }
  },
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
  const skipEnter = Boolean(reduce) || vtState.active;

  const catalogueQuery = useQuery(convexQuery(api.catalogue.listPublic, {}));
  const liveItems = catalogueQuery.data?.items ?? [];
  const teasers =
    liveItems.length > 0
      ? liveItems.slice(0, 3).map((item) => ({
          name: item.name,
          slug: item.slug,
          orgSlug: item.orgSlug,
          orgName: item.orgName,
          description: item.description ?? "Published OpenAPI API.",
          live: true as const,
        }))
      : FALLBACK_TEASERS.map((t) => ({ ...t, live: false as const }));
  const apiCount = liveItems.length > 0 ? liveItems.length : FALLBACK_TEASERS.length;
  const showSkeleton = catalogueQuery.isPending && liveItems.length === 0;

  const item = {
    hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: DUR.slow, ease: EASE },
    },
  };

  // Reduced motion: opacity only, no y-translate
  const itemReduced = {
    hidden: skipEnter ? { opacity: 1 } : { opacity: 0 },
    show: {
      opacity: 1,
      transition: { duration: DUR.slow, ease: EASE },
    },
  };
  const enterItem = reduce ? itemReduced : item;

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader />

      <main className="mx-auto flex max-w-5xl flex-col gap-20 px-4 py-16 sm:py-24">
        {/* Hero: copy left, proof strip right */}
        <section className="grid items-center gap-12 lg:grid-cols-2 lg:gap-10">
          <m.div
            className="flex max-w-xl flex-col gap-6"
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
              variants={enterItem}
            >
              Agent-first API marketplace
            </m.h1>
            <m.p
              className="text-lg text-muted-foreground"
              variants={enterItem}
            >
              Publishers list OpenAPI specs with per-call pricing. Consumers and
              agents prepay credits and hit a metered edge gateway. Publishers
              keep 95%.
            </m.p>
            <m.div
              className="flex flex-wrap items-center gap-3"
              variants={enterItem}
            >
              <Magnetic strength={0.3}>
                <Button asChild size="lg">
                  <Link
                    to="/catalogue"
                    style={{ viewTransitionName: "catalogue-heading" }}
                  >
                    Browse catalogue
                  </Link>
                </Button>
              </Magnetic>
              <Button asChild variant="outline" size="lg">
                <Link to="/sign-up/$">Get started</Link>
              </Button>
            </m.div>
            <m.p
              className="text-sm text-muted-foreground"
              variants={enterItem}
            >
              Zero balance blocks the call. No surprise overages.
            </m.p>
          </m.div>

          {/* Proof strip — catalogue teaser + stats */}
          <m.div
            className="flex flex-col gap-4"
            initial="hidden"
            animate="show"
            variants={{
              hidden: {},
              show: {
                transition: {
                  staggerChildren: reduce ? 0 : STAGGER * 2,
                  delayChildren: reduce ? 0 : 0.15,
                },
              },
            }}
          >
            <m.div
              className="flex flex-wrap items-baseline justify-between gap-3"
              variants={enterItem}
            >
              <p className="text-sm font-medium text-muted-foreground">
                Live catalogue
              </p>
              <p className="text-xs text-muted-foreground">
                Publishers keep{" "}
                <span className="font-semibold text-foreground">95%</span>
              </p>
            </m.div>

            <div className="flex flex-col gap-3">
              {showSkeleton
                ? Array.from({ length: 3 }).map((_, i) => (
                    <Card key={i} className="py-4">
                      <CardHeader className="gap-2 px-4 py-0">
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-3 w-1/3" />
                        <Skeleton className="h-3 w-4/5" />
                      </CardHeader>
                    </Card>
                  ))
                : teasers.map((teaser) => (
                    <m.div key={`${teaser.orgSlug}/${teaser.slug}`} variants={enterItem}>
                      {teaser.live ? (
                        <Link
                          to="/catalogue/$orgSlug/$projectSlug"
                          params={{
                            orgSlug: teaser.orgSlug,
                            projectSlug: teaser.slug,
                          }}
                          className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <TeaserCard
                            name={teaser.name}
                            orgSlug={teaser.orgSlug}
                            slug={teaser.slug}
                            orgName={teaser.orgName}
                            description={teaser.description}
                          />
                        </Link>
                      ) : (
                        <TeaserCard
                          name={teaser.name}
                          orgSlug={teaser.orgSlug}
                          slug={teaser.slug}
                          orgName={teaser.orgName}
                          description={teaser.description}
                        />
                      )}
                    </m.div>
                  ))}
            </div>

            <m.div
              className="grid grid-cols-2 gap-3 pt-1"
              variants={enterItem}
            >
              <Card className="py-4">
                <CardHeader className="gap-1 px-4 py-0">
                  <CardDescription>APIs listed</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">
                    <NumberTicker value={apiCount} />
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card className="py-4">
                <CardHeader className="gap-1 px-4 py-0">
                  <CardDescription>Publisher share</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">95%</CardTitle>
                </CardHeader>
              </Card>
            </m.div>
          </m.div>
        </section>

        {/* How it works */}
        <m.section
          className="grid gap-8 sm:grid-cols-2"
          initial={skipEnter ? false : { opacity: 0, y: reduce ? 0 : DIST }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: DUR.slow, ease: EASE }}
        >
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold tracking-tight">Publish</h2>
            <ol className="space-y-3 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1.</span> Paste an
                OpenAPI spec
              </li>
              <li>
                <span className="font-medium text-foreground">2.</span> Set{" "}
                <span className="font-mono text-xs">x-zevium-cost</span> per
                endpoint
              </li>
              <li>
                <span className="font-medium text-foreground">3.</span> Publish —
                earn 95% of every call
              </li>
            </ol>
          </div>
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold tracking-tight">Consume</h2>
            <ol className="space-y-3 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1.</span> Find an
                API in the catalogue
              </li>
              <li>
                <span className="font-medium text-foreground">2.</span> Create a
                key, top up credits
              </li>
              <li>
                <span className="font-medium text-foreground">3.</span> Call the
                metered gateway — agents welcome
              </li>
            </ol>
          </div>
        </m.section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted-foreground">
          <span>Zevium</span>
          <nav className="flex items-center gap-4">
            <Link
              to="/catalogue"
              className="transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Catalogue
            </Link>
            <Link
              to="/sign-in/$"
              className="transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function TeaserCard({
  name,
  orgSlug,
  slug,
  orgName,
  description,
}: {
  name: string;
  orgSlug: string;
  slug: string;
  orgName: string;
  description: string;
}) {
  return (
    <Card className="py-4 transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
      <CardHeader className="gap-2 px-4 py-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm">{name}</CardTitle>
            <CardDescription className="font-mono text-xs">
              {orgSlug}/{slug}
            </CardDescription>
          </div>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {orgName}
          </Badge>
        </div>
        <CardDescription className="line-clamp-1 text-xs">
          {description}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
