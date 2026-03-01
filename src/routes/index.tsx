import { createFileRoute, redirect } from "@tanstack/react-router";
import { ArrowRight, BarChart3, Code, Globe, TrendingUp, Users, Zap } from "lucide-react";

import { AnimatedBeamZev } from "~/components/animated-beam-zev";
import { NumberTicker } from "~/components/magicui/number-ticker";
import { Ripple } from "~/components/magicui/ripple";
import { TextAnimate } from "~/components/magicui/text-animate";
import { WordRotate } from "~/components/magicui/word-rotate";
import { PageHeaderContent } from "~/components/sidebar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { sessionQueryOptions } from "~/lib/auth";

export const Route = createFileRoute("/")({
  component: Home,
  loader: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());
    if (session.user) {
      throw redirect({ to: "/app" });
    }
  },
});

function Home() {
  const navigate = Route.useNavigate();
  return (
    <>
      <PageHeaderContent>
        <div className="flex w-full items-center gap-4">
          <div className="flex items-center space-x-2">
            <Globe className="h-5 w-5 text-primary" />
            <span className="font-semibold">API Hub Dashboard</span>
          </div>
        </div>
      </PageHeaderContent>

      <div
        className={`
        flex-1 space-y-8 p-4 pt-6
        md:p-8
      `}
      >
        {/* Hero Section */}
        <section className="relative overflow-hidden py-16">
          <Ripple />
          <div
            className={`
            absolute inset-0 bg-linear-to-br from-chart-1/5 via-transparent
            to-chart-3/5
          `}
          ></div>
          <div className="relative z-10 space-y-12">
            <div className="mx-auto max-w-4xl space-y-6 text-center">
              <h1
                className={`
                text-4xl leading-tight font-bold text-foreground
                lg:text-6xl
              `}
              >
                Integrate{" "}
                <WordRotate
                  className={`
                    inline text-4xl font-bold text-primary
                    lg:text-6xl
                  `}
                  duration={2500}
                  words={[
                    "payments",
                    "data",
                    "AI features",
                    "analytics",
                    "chat",
                    "notifications",
                    "storage",
                    "messaging",
                    "monitoring",
                    "search",
                    "email",
                    "CRM",
                    "e-commerce",
                    "social media",
                    "mapping",
                    "video calls",
                    "file uploads",
                  ]}
                />{" "}
                in one click
              </h1>
              <p
                className={`
                mx-auto max-w-3xl text-lg leading-relaxed text-muted-foreground
              `}
              >
                Connect any API faster, securely, and reliably through Zevium.
                <br />
                Our unified gateway simplifies integration, reduces complexity, and accelerates your development
                workflow.
              </p>
              <Button
                className={`
                  cursor-pointer bg-linear-to-r from-chart-1 to-chart-3
                  text-primary-foreground shadow-lg
                  hover:from-chart-1/90 hover:to-chart-3/90
                `}
                onClick={() => navigate({ to: "/app/catalogue" })}
                size="lg"
              >
                API hub
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
            <div className="flex justify-center">
              <AnimatedBeamZev />
            </div>
          </div>
        </section>

        {/* Stats Section */}
        <section
          className={`
          rounded-2xl bg-linear-to-r from-chart-1/5 via-muted/30 to-chart-4/5
          py-20
        `}
        >
          <div className="space-y-16 text-center">
            <div className="space-y-4">
              <TextAnimate
                animation="blurInUp"
                by="character"
                className={`
                  text-4xl font-bold text-foreground
                  lg:text-6xl
                `}
              >
                World's largest public API Hub
              </TextAnimate>
            </div>

            <div
              className={`
              grid gap-12
              md:grid-cols-3
            `}
            >
              <div className="group cursor-pointer text-center">
                <div
                  className={`
                  mb-6 inline-flex h-20 w-20 items-center justify-center
                  rounded-full bg-chart-1/10 transition-transform duration-300
                  group-hover:scale-110
                  dark:bg-chart-1/20
                `}
                >
                  <Users className="h-10 w-10 text-chart-1" />
                </div>
                <div
                  className={`
                  mb-3 text-5xl font-bold text-foreground
                  lg:text-7xl
                `}
                >
                  <NumberTicker value={7} />
                  M+
                </div>
                <p className="text-lg font-semibold text-chart-1">Developers</p>
              </div>
              <div className="group cursor-pointer text-center">
                <div
                  className={`
                  mb-6 inline-flex h-20 w-20 items-center justify-center
                  rounded-full bg-chart-4/10 transition-transform duration-300
                  group-hover:scale-110
                  dark:bg-chart-4/20
                `}
                >
                  <Code className="h-10 w-10 text-chart-4" />
                </div>
                <div
                  className={`
                  mb-3 text-5xl font-bold text-foreground
                  lg:text-7xl
                `}
                >
                  <NumberTicker value={75} />
                  K+
                </div>
                <p className="text-lg font-semibold text-chart-4">APIs in the Hub</p>
              </div>
              <div className="group cursor-pointer text-center">
                <div
                  className={`
                  mb-6 inline-flex h-20 w-20 items-center justify-center
                  rounded-full bg-chart-5/10 transition-transform duration-300
                  group-hover:scale-110
                  dark:bg-chart-5/20
                `}
                >
                  <TrendingUp className="h-10 w-10 text-chart-5" />
                </div>
                <div
                  className={`
                  mb-3 text-5xl font-bold text-foreground
                  lg:text-7xl
                `}
                >
                  <NumberTicker value={8} />
                  B+
                </div>
                <p className="text-lg font-semibold text-chart-5">API calls per month</p>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="space-y-24 py-20">
          {/* Publish APIs */}
          <div
            className={`
            grid items-center gap-16
            lg:grid-cols-2
          `}
          >
            <div>
              <Card
                className={`
                border-chart-2/20 bg-linear-to-br from-gray-900 via-chart-2/5
                to-gray-950 text-white shadow-2xl
              `}
              >
                <CardHeader className="pb-4">
                  <div className="mb-4 flex items-center gap-3">
                    <Badge className="bg-chart-1/10 px-3 py-1 text-chart-1" variant="secondary">
                      Node.js Axios
                    </Badge>
                    <Button
                      className={`
                      text-chart-3
                      hover:text-chart-3/80
                    `}
                      size="sm"
                      variant="ghost"
                    >
                      Copy Code
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 font-mono text-sm">
                  <div className="text-chart-3">const axios = require('axios');</div>
                  <div className="text-yellow-400">const options = {"{"};</div>
                  <div className="ml-4 text-chart-4">method: 'GET',</div>
                  <div className="ml-4 text-chart-4">url: 'https://example-api-url.in-game.ra...',</div>
                  <div className="ml-4 text-chart-5">params: {"{"}</div>
                  <div className="ml-8 text-orange-400">projectSlugType: '2'</div>
                  <div className="ml-4 text-chart-5">{"},"}</div>
                  <div className="ml-4 text-chart-3">headers: {"{"}</div>
                  <div className="ml-8 text-chart-4">'X-Zevium-Key': 'API-KEY-HERE',</div>
                  <div className="ml-8 text-chart-4">'X-Zevium-Host': 'example-in-live-sc...'</div>
                  <div className="ml-4 text-chart-3">{"}"}</div>
                  <div className="text-yellow-400">{"};"}</div>
                  <div className="mt-4 text-chart-3">try {"{"}</div>
                  <div className="ml-4 text-chart-4">const response = await axios.request(options);</div>
                  <div className="ml-4 text-chart-4">console.log(response.data);</div>
                  <div className="text-chart-3">{"} catch (error) {"}</div>
                  <div className="ml-4 text-red-400">console.error(error);</div>
                  <div className="text-chart-3">{"}"}</div>
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div
                  className={`
                  rounded-xl bg-chart-1/10 p-3
                  dark:bg-chart-1/20
                `}
                >
                  <Zap className="h-8 w-8 text-chart-1" />
                </div>
                <h3 className="text-4xl font-bold text-foreground">Publish APIs</h3>
              </div>
              <p className="text-lg leading-relaxed text-muted-foreground">
                Track subscriptions, highlight instructional content. Drive engagement.
                <strong className="text-foreground"> Monetize APIs</strong>
              </p>
            </div>
          </div>

          {/* Consume APIs */}
          <div
            className={`
            grid items-center gap-16
            lg:grid-cols-2
          `}
          >
            <div
              className={`
              order-2 space-y-6
              lg:order-1
            `}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`
                  rounded-xl bg-chart-4/10 p-3
                  dark:bg-chart-4/20
                `}
                >
                  <Globe className="h-8 w-8 text-chart-4" />
                </div>
                <h3 className="text-4xl font-bold text-foreground">Consume APIs</h3>
              </div>
              <p className="text-lg leading-relaxed text-muted-foreground">
                With indexed search functionality, discovering the perfect API match for your product roadmap is easier
                than ever.
              </p>
            </div>
            <div
              className={`
              order-1
              lg:order-2
            `}
            >
              <Card
                className={`
                border-chart-4/20 bg-linear-to-br from-white via-chart-4/5
                to-white shadow-2xl
                dark:from-gray-900 dark:via-chart-4/10 dark:to-gray-900
              `}
              >
                <CardContent className="p-8">
                  <div className="space-y-6">
                    <div className="flex items-center gap-3">
                      <div className="h-4 w-4 rounded-full bg-red-500 shadow-sm"></div>
                      <div
                        className={`
                        h-4 w-4 rounded-full bg-yellow-500 shadow-sm
                      `}
                      ></div>
                      <div
                        className={`
                        h-4 w-4 rounded-full bg-green-500 shadow-sm
                      `}
                      ></div>
                      <div className="ml-auto text-xs text-muted-foreground">API Browser</div>
                    </div>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-muted-foreground/30"></div>
                        <div
                          className={`
                          h-3 flex-1 rounded bg-muted-foreground/30
                        `}
                        ></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-chart-1"></div>
                        <div className="h-3 w-2/3 rounded bg-chart-1"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-muted-foreground/30"></div>
                        <div
                          className={`
                          h-3 w-1/2 rounded bg-muted-foreground/30
                        `}
                        ></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-chart-5"></div>
                        <div className="h-3 w-3/4 rounded bg-chart-5"></div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Manage APIs */}
          <div
            className={`
            grid items-center gap-16
            lg:grid-cols-2
          `}
          >
            <div>
              <Card
                className={`
                border-chart-5/20 bg-linear-to-br from-white via-chart-5/5
                to-white shadow-2xl
                dark:from-gray-900 dark:via-chart-5/10 dark:to-gray-900
              `}
              >
                <CardContent className="p-8">
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <Badge
                        className={`
                          border-chart-1/20 bg-linear-to-r from-chart-1/10
                          to-chart-3/10 px-3 py-1 text-chart-1
                        `}
                        variant="outline"
                      >
                        General Settings
                      </Badge>
                      <div className="text-sm font-medium text-chart-4">100%</div>
                    </div>
                    <div className="space-y-5">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">API Calls</span>
                          <span className="text-sm font-bold">8.8/10</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-muted">
                          <div
                            className={`
                              h-3 rounded-full bg-chart-4 transition-all
                              duration-500
                            `}
                            style={{ width: "88%" }}
                          ></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">Performance</span>
                          <span className="text-sm font-bold">100%</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-muted">
                          <div
                            className={`
                            h-3 w-full rounded-full bg-chart-4 transition-all
                            duration-500
                          `}
                          ></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">Uptime</span>
                          <span className="text-sm font-bold">99.9%</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-muted">
                          <div
                            className={`
                              h-3 rounded-full bg-chart-1 transition-all
                              duration-500
                            `}
                            style={{ width: "99%" }}
                          ></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div
                  className={`
                  rounded-xl bg-chart-5/10 p-3
                  dark:bg-chart-5/20
                `}
                >
                  <BarChart3 className="h-8 w-8 text-chart-5" />
                </div>
                <h3 className="text-4xl font-bold text-foreground">Manage APIs</h3>
              </div>
              <p className="text-lg leading-relaxed text-muted-foreground">
                Never wonder how many APIs you have or how they're being used. Instead, surface performance and usage
                patterns instantly and keep a birds-eye view of your{" "}
                <strong className="text-foreground">API ecosystem</strong>.
              </p>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-20 border-t border-border/40 to-chart-2/5 py-10">
          <div
            className={`
            grid gap-12
            md:grid-cols-4
          `}
          >
            <div className="col-span-2 space-y-6">
              <div className="flex items-center space-x-3">
                <Globe className="h-8 w-8 text-primary" />
                <span className="text-2xl font-bold">Zevium API Hub</span>
              </div>
              <p className="max-w-md leading-relaxed text-muted-foreground">
                The world's largest public API hub. Discover, consume, and manage APIs with ease. Build the future with
                our comprehensive API ecosystem.
              </p>
              <div className="flex space-x-3">
                <Button className="hover:border-chart-1/20 hover:bg-chart-1/5" size="icon" variant="outline">
                  <Globe className="h-5 w-5" />
                </Button>
                <Button className="hover:border-chart-4/20 hover:bg-chart-4/5" size="icon" variant="outline">
                  <Code className="h-5 w-5" />
                </Button>
                <Button className="hover:border-chart-5/20 hover:bg-chart-5/5" size="icon" variant="outline">
                  <Users className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <div className="space-y-4">
              <h4 className="text-lg font-semibold text-foreground">Platform</h4>
              <ul className="space-y-3 text-muted-foreground">
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    Browse APIs
                  </a>
                </li>
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    Publish API
                  </a>
                </li>
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    API Testing
                  </a>
                </li>
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    Documentation
                  </a>
                </li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="text-lg font-semibold text-foreground">Company</h4>
              <ul className="space-y-3 text-muted-foreground">
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    About
                  </a>
                </li>
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    Careers
                  </a>
                </li>
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    Contact
                  </a>
                </li>
                <li>
                  <a
                    className={`
                    transition-colors
                    hover:text-foreground
                  `}
                    href="#"
                  >
                    Blog
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div
            className={`
            mt-16 flex flex-col items-center justify-between border-t
            border-border/40 pt-8
            md:flex-row
          `}
          >
            <p className="text-muted-foreground">© 2025 Zevium API Hub. All rights reserved.</p>
            <div
              className={`
              mt-4 flex space-x-8 text-muted-foreground
              md:mt-0
            `}
            >
              <a
                className={`
                transition-colors
                hover:text-foreground
              `}
                href="#"
              >
                Privacy Policy
              </a>
              <a
                className={`
                transition-colors
                hover:text-foreground
              `}
                href="#"
              >
                Terms of Service
              </a>
              <a
                className={`
                transition-colors
                hover:text-foreground
              `}
                href="#"
              >
                Support
              </a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
