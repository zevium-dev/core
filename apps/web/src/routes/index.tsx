import { Show } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";

import { BrandMark } from "#/components/brand-mark";
import { Magnetic } from "#/components/motion/magnetic";
import { Reveal } from "#/components/motion/reveal";
import { PublicHeader } from "#/components/public-header";
import { SyntaxCode } from "#/components/syntax-code";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import {
  buildMcpConfigSnippet,
  discoveryEndpointUrl,
  mcpEndpointUrl,
  pickLandingTeasers,
  resolveGatewayOrigin,
} from "#/lib/landing";
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

const HOW_STEPS = [
  {
    n: "1",
    title: "Publish an OpenAPI spec",
    bodyBefore: "Pricing lives in the spec — set ",
    mono: "x-zevium-cost",
    bodyAfter: " per endpoint. Spec is the contract and the price sheet.",
  },
  {
    n: "2",
    title: "Discover and call",
    bodyBefore:
      "Agents and devs find APIs in the catalogue, then hit the metered edge gateway with one key.",
    mono: null,
    bodyAfter: null,
  },
  {
    n: "3",
    title: "Credits settle per call",
    bodyBefore:
      "Zero balance blocks the call. Publishers keep 95%; platform takes 5%.",
    mono: null,
    bodyAfter: null,
  },
] as const;

const GITHUB_URL = "https://github.com/zevium-dev/core";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    // Prefetch public catalogue for hero teaser; ignore failures (static fallback).
    const queryOpts = convexQuery(api.catalogue.listPublic, {});
    try {
      if (typeof window !== "undefined") {
        void context.queryClient.prefetchQuery(queryOpts);
        return;
      }
      await context.queryClient.ensureQueryData(queryOpts);
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
  const teasers = pickLandingTeasers(liveItems, FALLBACK_TEASERS);
  const showSkeleton = catalogueQuery.isPending && liveItems.length === 0;

  const gatewayOrigin = resolveGatewayOrigin(
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
  );
  const mcpUrl = mcpEndpointUrl(gatewayOrigin);
  const discoveryUrl = discoveryEndpointUrl(gatewayOrigin);
  const mcpSnippet = buildMcpConfigSnippet(mcpUrl);

  const item = {
    hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: DUR.slow, ease: EASE },
    },
  };

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

      <main className="mx-auto flex max-w-5xl flex-col gap-24 px-4 py-16 sm:py-24">
        {/* Hero */}
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
              One key. Every API. Pay per call.
            </m.h1>
            <m.p className="text-lg text-muted-foreground" variants={enterItem}>
              Discover APIs, see exact prices before calling, and route every
              request through one metered gateway. No subscriptions. No surprise
              overages.
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
              <Show
                when="signed-out"
                fallback={
                  <Button asChild variant="outline" size="lg">
                    <Link to="/app">Open dashboard</Link>
                  </Button>
                }
              >
                <Button asChild variant="outline" size="lg">
                  <Link to="/sign-up/$">Get started</Link>
                </Button>
              </Show>
            </m.div>
            <m.p className="text-sm text-muted-foreground" variants={enterItem}>
              $1 buys 10,000 credits. Zero balance stops requests.
            </m.p>
          </m.div>

          <m.div
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
            <m.div variants={enterItem}>
              <Card>
                <CardHeader>
                  <CardTitle>Request</CardTitle>
                  <CardAction>
                    <Badge variant="outline">100 credits</Badge>
                  </CardAction>
                  <CardDescription>
                    One authenticated, credit-gated call.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">GET</Badge>
                    <code className="break-all text-sm text-[var(--syntax-string)]">
                      /acme/summarize/v1/summarize
                    </code>
                  </div>
                  <div className="flex flex-col gap-2 font-mono text-xs text-muted-foreground">
                    <p>
                      <span className="text-[var(--syntax-function)]">key</span>{" "}
                      <span className="text-[var(--syntax-string)]">
                        verified
                      </span>
                    </p>
                    <p>
                      <span className="text-[var(--syntax-function)]">
                        wallet
                      </span>{" "}
                      <span className="text-[var(--syntax-string)]">
                        reserved
                      </span>{" "}
                      · <span className="text-[var(--syntax-number)]">100</span>{" "}
                      credits
                    </p>
                    <p>
                      <span className="text-[var(--syntax-function)]">
                        upstream
                      </span>{" "}
                      <span className="text-[var(--syntax-string)]">
                        streamed
                      </span>{" "}
                      · <span className="text-[var(--syntax-number)]">184</span>{" "}
                      ms
                    </p>
                  </div>
                </CardContent>
                <CardFooter className="justify-between gap-3 border-t">
                  <Badge>200 OK</Badge>
                  <span className="text-sm text-muted-foreground">
                    publisher earns{" "}
                    <span className="font-mono text-[var(--syntax-number)]">
                      95
                    </span>
                  </span>
                </CardFooter>
              </Card>
            </m.div>
          </m.div>
        </section>

        {/* How it works */}
        <section className="flex flex-col gap-6">
          <Reveal>
            <h2 className="text-2xl font-semibold tracking-tight">
              How it works
            </h2>
          </Reveal>
          <div className="flex flex-col">
            <Separator />
            {HOW_STEPS.map((step, i) => (
              <div key={step.n}>
                <Reveal delay={i * STAGGER}>
                  <div className="grid gap-2 py-5 sm:grid-cols-[2rem_12rem_1fr] sm:gap-4">
                    <span className="font-mono text-xs text-muted-foreground">
                      0{step.n}
                    </span>
                    <h3 className="text-sm font-medium">{step.title}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {step.bodyBefore}
                      {step.mono ? (
                        <span className="font-mono text-xs text-foreground">
                          {step.mono}
                        </span>
                      ) : null}
                      {step.bodyAfter}
                    </p>
                  </div>
                </Reveal>
                <Separator />
              </div>
            ))}
          </div>
        </section>

        <Reveal as="section" className="flex flex-col gap-8">
          <Separator />
          <div className="grid gap-10 md:grid-cols-2">
            <div className="flex flex-col items-start gap-3">
              <p className="font-mono text-xs text-muted-foreground">
                CONSUMERS
              </p>
              <h2 className="text-xl font-semibold tracking-tight">
                One wallet across every API
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Fund your organization once. Issue member keys, set spend caps,
                inspect every call, and stop automatically at zero.
              </p>
              <Button asChild variant="outline">
                <Link to="/catalogue">Find an API</Link>
              </Button>
            </div>
            <div className="flex flex-col items-start gap-3">
              <p className="font-mono text-xs text-muted-foreground">
                PUBLISHERS
              </p>
              <h2 className="text-xl font-semibold tracking-tight">
                Ship your spec. Keep 95%.
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Put endpoint prices in OpenAPI. Zevium handles keys, credit
                gates, usage records, earnings, and Stripe payouts.
              </p>
              <Button asChild variant="outline">
                <Link to="/app/projects">Start publishing</Link>
              </Button>
            </div>
          </div>
          <Separator />
        </Reveal>

        {/* For agents */}
        <Reveal as="section" className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">For agents</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Machine-readable discovery plus metered agent tooling. Search the
            catalogue, load only the tools you need, call through the same
            credit-gated gateway as humans.
          </p>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Surfaces</CardTitle>
                <CardDescription>
                  Machine-readable gateway endpoints for agent clients.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col gap-2 font-mono text-xs text-muted-foreground">
                  <span className="break-all">{mcpUrl}</span>
                  <span className="break-all">{discoveryUrl}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  MCP endpoint +{" "}
                  <span className="font-mono text-xs">/discovery</span> index
                  with per-endpoint pricing. No unmetered side doors.
                </p>
              </CardContent>
            </Card>
            <McpConfigBlock snippet={mcpSnippet} />
          </div>
        </Reveal>

        {/* Live catalogue teasers (relocated into below-fold flow) */}
        <section className="flex flex-col gap-6">
          <Reveal className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-semibold tracking-tight">
                Live catalogue
              </h2>
              <p className="text-sm text-muted-foreground">
                Public listings with real per-call pricing.
              </p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/catalogue">View all</Link>
            </Button>
          </Reveal>
          <div className="grid gap-3 sm:grid-cols-3">
            {showSkeleton
              ? Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i}>
                    <CardHeader>
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-3 w-1/3" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-3 w-4/5" />
                    </CardContent>
                  </Card>
                ))
              : teasers.map((teaser, i) => (
                  <Reveal
                    key={`${teaser.orgSlug}/${teaser.slug}`}
                    delay={i * STAGGER}
                  >
                    {teaser.live ? (
                      <Link
                        to="/catalogue/$orgSlug/$projectSlug"
                        params={{
                          orgSlug: teaser.orgSlug,
                          projectSlug: teaser.slug,
                        }}
                        className="group block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
                      <Link
                        to="/catalogue"
                        className="group block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <TeaserCard
                          name={teaser.name}
                          orgSlug={teaser.orgSlug}
                          slug={teaser.slug}
                          orgName={teaser.orgName}
                          description={teaser.description}
                        />
                      </Link>
                    )}
                  </Reveal>
                ))}
          </div>
        </section>
      </main>

      <footer>
        <Separator />
        <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Link
              to="/"
              aria-label="Zevium"
              className="flex items-center gap-0.5 rounded-md text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <BrandMark className="h-3 w-4" />
              <span aria-hidden="true">evium</span>
            </Link>
            <p className="text-xs text-muted-foreground">
              Agent-first, per-call API marketplace.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Product</span>
            <Link
              to="/catalogue"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Catalogue
            </Link>
            <Link
              to="/docs"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Docs
            </Link>
            <a
              href="/catalogue#pricing"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Pricing
            </a>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Publishers</span>
            <Link
              to="/app/projects"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Start publishing
            </Link>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Company</span>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        </div>
        <Separator />
        <div>
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground">
            <span>© {new Date().getFullYear()} Zevium</span>
            <Show when="signed-out">
              <Link
                to="/sign-in/$"
                className="transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
              >
                Sign in
              </Link>
            </Show>
            <Show when="signed-in">
              <Link
                to="/app"
                className="transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
              >
                Dashboard
              </Link>
            </Show>
          </div>
        </div>
      </footer>
    </div>
  );
}

function McpConfigBlock({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success("MCP config copied");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>MCP config</CardTitle>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onCopy()}
            aria-label="Copy MCP config"
          >
            {copied ? (
              <Check data-icon="inline-start" />
            ) : (
              <Copy data-icon="inline-start" />
            )}
            Copy
          </Button>
        </CardAction>
        <CardDescription>
          Paste into your agent client. Replace YOUR_API_KEY with a Zevium key.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="max-h-56 min-w-0 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre">
          <SyntaxCode code={snippet} lang="json" />
        </pre>
      </CardContent>
    </Card>
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
    <Card className="h-full transition-[translate,scale,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-active:scale-100">
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardAction>
          <Badge variant="secondary" className="shrink-0">
            {orgName}
          </Badge>
        </CardAction>
        <CardDescription>
          <code>
            {orgSlug}/{slug}
          </code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {description}
        </p>
      </CardContent>
    </Card>
  );
}
