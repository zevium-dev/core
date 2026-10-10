import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { BrandMark } from "#/components/brand-mark";
import { Magnetic } from "#/components/motion/magnetic";
import { Reveal } from "#/components/motion/reveal";
import { PublicHeader } from "#/components/public-header";
import { AgentInstall } from "#/components/agent-install";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import {
  discoveryEndpointUrl,
  mcpEndpointUrl,
  pickLandingTeasers,
  resolveGatewayOrigin,
} from "#/lib/landing";
import { STAGGER } from "#/lib/motion";

const HOW_STEPS = [
  {
    n: "1",
    title: "Publish an OpenAPI spec",
    bodyBefore: "Set ",
    mono: "x-zevium-cost",
    bodyAfter:
      " per endpoint to put prices alongside request and response definitions.",
  },
  {
    n: "2",
    title: "Discover and call",
    bodyBefore:
      "Developers and agents choose an API from the catalogue and call it with a Zevium key.",
    mono: null,
    bodyAfter: null,
  },
  {
    n: "3",
    title: "Pay for successful calls",
    bodyBefore:
      "Successful calls spend prepaid credits. Publishers earn 95% of each charge; Zevium keeps 5%.",
    mono: null,
    bodyAfter: null,
  },
] as const;

const GITHUB_URL = "https://github.com/zevium-dev/core";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const queryOpts = convexQuery(api.catalogue.listPublic, {});
    if (typeof window !== "undefined") {
      // Only catalogue teasers need data; render the home shell immediately.
      void context.queryClient.prefetchQuery(queryOpts);
      return;
    }

    // Await on the server so dehydrated cache and rendered HTML cannot race.
    // Failure still leaves the public shell available with its stable skeleton.
    try {
      await context.queryClient.ensureQueryData(queryOpts);
    } catch {
      context.queryClient.removeQueries({ queryKey: queryOpts.queryKey });
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
  const { userId } = Route.useRouteContext();
  const catalogueQuery = useQuery(convexQuery(api.catalogue.listPublic, {}));
  const liveItems = catalogueQuery.data?.items ?? [];
  const teasers = pickLandingTeasers(liveItems);
  const showSkeleton = catalogueQuery.isPending && liveItems.length === 0;

  const gatewayOrigin = resolveGatewayOrigin(
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
  );
  const mcpUrl = mcpEndpointUrl(gatewayOrigin);
  const discoveryUrl = discoveryEndpointUrl(gatewayOrigin);

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader />

      <main
        id="main-content"
        style={{ viewTransitionName: "main-content" }}
        tabIndex={-1}
        className="flex w-full flex-col gap-24 px-4 py-16 outline-none sm:py-24 md:px-6"
      >
        {/* Hero */}
        <section className="grid items-center gap-12 lg:grid-cols-2 lg:gap-10">
          <div className="flex max-w-xl flex-col gap-6">
            <h1 className="min-w-0 text-4xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-5xl">
              APIs for your code and agents. Pay per call.
            </h1>
            <p className="text-lg text-muted-foreground">
              Find an API, try a free mock response, then use prepaid credits
              for live calls. Your Zevium key works across the catalogue, so
              each new API uses the same wallet.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Magnetic strength={0.3}>
                <Button asChild size="lg" className="min-h-11">
                  <Link to="/catalogue">
                    <span
                      className="inline-block"
                      style={{ viewTransitionName: "catalogue-heading" }}
                    >
                      Browse catalogue
                    </span>
                  </Link>
                </Button>
              </Magnetic>
              {userId ? (
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="min-h-11"
                >
                  <Link to="/app">Open dashboard</Link>
                </Button>
              ) : (
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="min-h-11"
                >
                  <Link to="/sign-up/$">Create account</Link>
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              $1 buys 10,000 credits. Live calls stop when your wallet runs out.
            </p>
          </div>

          <aside aria-label="Live request lifecycle">
            <div>
              <Card>
                <CardHeader>
                  <CardTitle>Every live request</CardTitle>
                  <CardDescription>
                    The gateway checks your balance before contacting the
                    publisher.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 text-sm">
                  {[
                    ["01", "Check your API key"],
                    ["02", "Read the endpoint price"],
                    ["03", "Reserve credits if your wallet can cover the call"],
                    ["04", "Return the response and charge only on success"],
                  ].map(([number, label]) => (
                    <div
                      key={number}
                      className="grid grid-cols-[2rem_1fr] items-start gap-3 border-b pb-4 last:border-0 last:pb-0"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {number}
                      </span>
                      <span>{label}</span>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Badge variant="secondary">prepaid only</Badge>
                    <Badge variant="outline">prices in the spec</Badge>
                    <Badge variant="outline">streamed</Badge>
                  </div>
                </CardContent>
              </Card>
            </div>
          </aside>
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
                    <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
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
                A shared API wallet for your team
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Add credits to your organization’s wallet. Members call APIs
                with their own keys; admins can set monthly key limits and
                review usage by member.
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
                Set endpoint prices in your OpenAPI spec. Zevium collects
                prepaid credits for successful calls and sends your share to
                your connected Stripe account.
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
            Connect your agent over MCP to search for APIs, read a matching
            API’s reference, and call its endpoints. Calls draw from your
            organization’s wallet.
          </p>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Connect over MCP</CardTitle>
                <CardDescription>
                  Use MCP tools or fetch the discovery index directly.
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
                  with endpoint prices so your agent can check cost before
                  calling.
                </p>
              </CardContent>
            </Card>
            <AgentInstall gatewayOrigin={gatewayOrigin} />
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
                Compare endpoint prices and try free mock responses.
              </p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/catalogue">View all</Link>
            </Button>
          </Reveal>
          {showSkeleton ? (
            <div
              className="grid gap-3 sm:grid-cols-3"
              aria-label="Loading APIs"
            >
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader>
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-3 w-4/5" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : teasers.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {teasers.map((teaser, i) => (
                <Reveal
                  key={`${teaser.publisherHandle}/${teaser.slug}`}
                  delay={i * STAGGER}
                >
                  <Link
                    to="/catalogue/$publisherHandle/$projectSlug"
                    params={{
                      publisherHandle: teaser.publisherHandle,
                      projectSlug: teaser.slug,
                    }}
                    className="group block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <TeaserCard
                      name={teaser.name}
                      publisherHandle={teaser.publisherHandle}
                      slug={teaser.slug}
                      orgName={teaser.orgName}
                      description={teaser.description}
                    />
                  </Link>
                </Reveal>
              ))}
            </div>
          ) : (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">
                  {catalogueQuery.isError
                    ? "Catalogue unavailable"
                    : "No public APIs yet"}
                </CardTitle>
                <CardDescription>
                  {catalogueQuery.isError
                    ? "We couldn’t load the catalogue. Retry to see available APIs."
                    : "Publish an API and make it public to list it here."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {catalogueQuery.isError ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void catalogueQuery.refetch()}
                  >
                    Retry
                  </Button>
                ) : (
                  <Button asChild variant="outline">
                    <Link to="/app/projects">Publish an API</Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </section>
      </main>

      <footer>
        <Separator />
        <div className="flex w-full flex-col gap-5 px-4 py-8 sm:flex-row sm:items-center sm:justify-between md:px-6">
          <div className="flex min-w-0 flex-col gap-2">
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
          <nav
            aria-label="Footer navigation"
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
          >
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
            <Link
              to="/app/projects"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              Publish
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
            >
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function TeaserCard({
  name,
  publisherHandle,
  slug,
  orgName,
  description,
}: {
  name: string;
  publisherHandle: string;
  slug: string;
  orgName: string;
  description: string;
}) {
  return (
    <Card
      data-transition-surface={`api-surface-${publisherHandle}/${slug}`}
      className="h-full transition-[translate,scale,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-active:scale-100"
    >
      <CardHeader>
        <CardTitle className="w-fit max-w-full [overflow-wrap:anywhere]">
          {name}
        </CardTitle>
        <CardAction>
          <Badge variant="secondary" className="shrink-0">
            {orgName}
          </Badge>
        </CardAction>
        <CardDescription>
          <code>
            {publisherHandle}/{slug}
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
