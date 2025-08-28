import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border p-8">
          <h1 className="text-foreground text-2xl leading-tight font-semibold md:text-3xl">
            Looking for APIs? Find and subscribe instantly.
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">
            Browse a curated catalog. Transparent pricing. Start calling in minutes.
          </p>
          <div className="mt-6">
            <Link to={"/"}>
              <Button size="lg">Explore APIs</Button>
            </Link>
          </div>
        </div>

        <div className="rounded-lg border p-8">
          <h2 className="text-foreground text-2xl leading-tight font-semibold md:text-3xl">
            Built an API? Publish & earn revenue.
          </h2>
          <p className="text-muted-foreground mt-3 text-sm">
            List your API, set plans, and get paid. Analytics and developer-first tools included.
          </p>
          <div className="mt-6">
            <Link to={"/"}>
              <Button size="lg" variant="outline">
                List Your API
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
