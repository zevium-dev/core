import { createLazyFileRoute } from "@tanstack/react-router";

import { Footer } from "~/components/footer";
import { Hero } from "~/components/home/hero";
import { PopularApis } from "~/components/home/popular-apis";
import { Stats } from "~/components/home/stats";
import { Testimonials } from "~/components/home/testimonials";
import { TopNav } from "~/components/top-navbar";

export const Route = createLazyFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="flex min-h-svh flex-col">
      <TopNav />

      <main className="flex-1">
        <Hero />

        <section aria-labelledby="popular-apis" className="border-t">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
            <h2 className="text-foreground mb-8 text-xl font-semibold tracking-tight" id="popular-apis">
              Popular APIs
            </h2>
            <PopularApis />
          </div>
        </section>

        <section aria-labelledby="success-stats" className="border-t">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
            <h2 className="sr-only" id="success-stats">
              Success Stats
            </h2>
            <Stats />
          </div>
        </section>

        <section aria-labelledby="testimonials" className="border-t">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
            <h2 className="text-foreground mb-8 text-xl font-semibold tracking-tight" id="testimonials">
              Loved by Developers & API Providers
            </h2>
            <Testimonials />
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
