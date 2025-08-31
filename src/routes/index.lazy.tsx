import { createLazyFileRoute } from "@tanstack/react-router";
import { ArrowRight, BarChart3, Code, Globe, TrendingUp, Users, Zap } from "lucide-react";
import React from "react";

import { AnimatedBeamZev } from "~/components/animated-beam-zev";
import { NumberTicker } from "~/components/magicui/number-ticker";
import { Ripple } from "~/components/magicui/ripple";
import { TextAnimate } from "~/components/magicui/text-animate";
import { WordRotate } from "~/components/magicui/word-rotate";
import { PageHeaderContent } from "~/components/sidebar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

export const Route = createLazyFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <>
      <PageHeaderContent>
        <div className="flex w-full items-center gap-4">
          <div className="flex items-center space-x-2">
            <Globe className="h-5 w-5 text-blue-600" />
            <span className="font-semibold">API Hub Dashboard</span>
          </div>
          <div className="ml-auto flex items-center space-x-2">
            <Button size="sm" variant="ghost">
              Sign in
            </Button>
            <Button className="bg-blue-600 hover:bg-blue-700" size="sm">
              Get started
            </Button>
          </div>
        </div>
      </PageHeaderContent>

      <div className="flex-1 space-y-8 p-4 pt-6 md:p-8">
        {/* Hero Section */}
        <section className="relative overflow-hidden py-16">
          <Ripple />
          <div className="relative z-10 space-y-12">
            <div className="mx-auto max-w-4xl space-y-6 text-center">
              <h1 className="text-foreground text-4xl leading-tight font-bold lg:text-6xl">
                Integrate{" "}
                <WordRotate
                  className="inline text-4xl font-bold text-blue-600 lg:text-6xl"
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
              <p className="text-muted-foreground mx-auto max-w-3xl text-lg leading-relaxed">
                Connect any API faster, securely, and reliably through Zevium.
                <br />
                Our unified gateway simplifies integration, reduces complexity, and accelerates your development
                workflow.
              </p>
              <Button className="bg-blue-600 hover:bg-blue-700" size="lg">
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
        <section className="bg-muted/30 rounded-2xl py-20">
          <div className="space-y-16 text-center">
            <div className="space-y-4">
              <TextAnimate
                animation="blurInUp"
                by="character"
                className="text-foreground text-4xl font-bold lg:text-6xl"
              >
                World's largest public API Hub
              </TextAnimate>
            </div>

            <div className="grid gap-12 md:grid-cols-3">
              <div className="group cursor-pointer text-center">
                <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full bg-blue-100 transition-transform duration-300 group-hover:scale-110 dark:bg-blue-900/20">
                  <Users className="h-10 w-10 text-blue-600" />
                </div>
                <div className="text-foreground mb-3 text-5xl font-bold lg:text-7xl">
                  <NumberTicker value={7} />
                  M+
                </div>
                <p className="text-lg font-semibold text-blue-600">Developers</p>
              </div>
              <div className="group cursor-pointer text-center">
                <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full bg-green-100 transition-transform duration-300 group-hover:scale-110 dark:bg-green-900/20">
                  <Code className="h-10 w-10 text-green-600" />
                </div>
                <div className="text-foreground mb-3 text-5xl font-bold lg:text-7xl">
                  <NumberTicker value={75} />
                  K+
                </div>
                <p className="text-lg font-semibold text-green-600">APIs in the Hub</p>
              </div>
              <div className="group cursor-pointer text-center">
                <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full bg-purple-100 transition-transform duration-300 group-hover:scale-110 dark:bg-purple-900/20">
                  <TrendingUp className="h-10 w-10 text-purple-600" />
                </div>
                <div className="text-foreground mb-3 text-5xl font-bold lg:text-7xl">
                  <NumberTicker value={8} />
                  B+
                </div>
                <p className="text-lg font-semibold text-purple-600">API calls per month</p>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="space-y-24 py-20">
          {/* Publish APIs */}
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div>
              <Card className="border-gray-700 bg-gray-900 text-white shadow-2xl dark:bg-gray-950">
                <CardHeader className="pb-4">
                  <div className="mb-4 flex items-center gap-3">
                    <Badge className="bg-blue-100 px-3 py-1 text-blue-900" variant="secondary">
                      Node.js Axios
                    </Badge>
                    <Button className="text-blue-400 hover:text-blue-300" size="sm" variant="ghost">
                      Copy Code
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 font-mono text-sm">
                  <div className="text-blue-400">const axios = require('axios');</div>
                  <div className="text-yellow-400">const options = {"{"};</div>
                  <div className="ml-4 text-green-400">method: 'GET',</div>
                  <div className="ml-4 text-green-400">url: 'https://example-api-url.in-game.ra...',</div>
                  <div className="ml-4 text-purple-400">params: {"{"}</div>
                  <div className="ml-8 text-orange-400">projectSlugType: '2'</div>
                  <div className="ml-4 text-purple-400">{"},"}</div>
                  <div className="ml-4 text-blue-400">headers: {"{"}</div>
                  <div className="ml-8 text-green-400">'X-Zevium-Key': 'API-KEY-HERE',</div>
                  <div className="ml-8 text-green-400">'X-Zevium-Host': 'example-in-live-sc...'</div>
                  <div className="ml-4 text-blue-400">{"}"}</div>
                  <div className="text-yellow-400">{"};"}</div>
                  <div className="mt-4 text-blue-400">try {"{"}</div>
                  <div className="ml-4 text-green-400">const response = await axios.request(options);</div>
                  <div className="ml-4 text-green-400">console.log(response.data);</div>
                  <div className="text-blue-400">{"} catch (error) {"}</div>
                  <div className="ml-4 text-red-400">console.error(error);</div>
                  <div className="text-blue-400">{"}"}</div>
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="rounded-xl bg-blue-100 p-3 dark:bg-blue-900/20">
                  <Zap className="h-8 w-8 text-blue-600" />
                </div>
                <h3 className="text-foreground text-4xl font-bold">Publish APIs</h3>
              </div>
              <p className="text-muted-foreground text-lg leading-relaxed">
                Track subscriptions, highlight instructional content. Drive engagement.
                <strong className="text-foreground"> Monetize APIs</strong>
              </p>
            </div>
          </div>

          {/* Consume APIs */}
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div className="order-2 space-y-6 lg:order-1">
              <div className="flex items-center gap-4">
                <div className="rounded-xl bg-green-100 p-3 dark:bg-green-900/20">
                  <Globe className="h-8 w-8 text-green-600" />
                </div>
                <h3 className="text-foreground text-4xl font-bold">Consume APIs</h3>
              </div>
              <p className="text-muted-foreground text-lg leading-relaxed">
                With indexed search functionality, discovering the perfect API match for your product roadmap is easier
                than ever.
              </p>
            </div>
            <div className="order-1 lg:order-2">
              <Card className="border bg-white shadow-2xl dark:bg-gray-900">
                <CardContent className="p-8">
                  <div className="space-y-6">
                    <div className="flex items-center gap-3">
                      <div className="h-4 w-4 rounded-full bg-red-500"></div>
                      <div className="h-4 w-4 rounded-full bg-yellow-500"></div>
                      <div className="h-4 w-4 rounded-full bg-green-500"></div>
                    </div>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-gray-300 dark:bg-gray-600"></div>
                        <div className="h-3 flex-1 rounded bg-gray-300 dark:bg-gray-600"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-blue-500"></div>
                        <div className="h-3 w-2/3 rounded bg-blue-500"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-gray-300 dark:bg-gray-600"></div>
                        <div className="h-3 w-1/2 rounded bg-gray-300 dark:bg-gray-600"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-purple-500"></div>
                        <div className="h-3 w-3/4 rounded bg-purple-500"></div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Manage APIs */}
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div>
              <Card className="border bg-white shadow-2xl dark:bg-gray-900">
                <CardContent className="p-8">
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <Badge className="px-3 py-1" variant="outline">
                        General Settings
                      </Badge>
                      <div className="text-muted-foreground text-sm font-medium">100%</div>
                    </div>
                    <div className="space-y-5">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">API Calls</span>
                          <span className="text-sm font-bold">8.8/10</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                          <div
                            className="h-3 rounded-full bg-green-500 transition-all duration-500"
                            style={{ width: "88%" }}
                          ></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">Performance</span>
                          <span className="text-sm font-bold">100%</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                          <div className="h-3 w-full rounded-full bg-green-500 transition-all duration-500"></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">Uptime</span>
                          <span className="text-sm font-bold">99.9%</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-gray-200 dark:bg-gray-700">
                          <div
                            className="h-3 rounded-full bg-blue-500 transition-all duration-500"
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
                <div className="rounded-xl bg-purple-100 p-3 dark:bg-purple-900/20">
                  <BarChart3 className="h-8 w-8 text-purple-600" />
                </div>
                <h3 className="text-foreground text-4xl font-bold">Manage APIs</h3>
              </div>
              <p className="text-muted-foreground text-lg leading-relaxed">
                Never wonder how many APIs you have or how they're being used. Instead, surface performance and usage
                patterns instantly and keep a birds-eye view of your{" "}
                <strong className="text-foreground">API ecosystem</strong>.
              </p>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-border/40 mt-20 border-t py-20">
          <div className="grid gap-12 md:grid-cols-4">
            <div className="col-span-2 space-y-6">
              <div className="flex items-center space-x-3">
                <Globe className="h-8 w-8 text-blue-600" />
                <span className="text-2xl font-bold">Zevium API Hub</span>
              </div>
              <p className="text-muted-foreground max-w-md leading-relaxed">
                The world's largest public API hub. Discover, consume, and manage APIs with ease. Build the future with
                our comprehensive API ecosystem.
              </p>
              <div className="flex space-x-3">
                <Button className="hover:border-blue-200 hover:bg-blue-50" size="icon" variant="outline">
                  <Globe className="h-5 w-5" />
                </Button>
                <Button className="hover:border-green-200 hover:bg-green-50" size="icon" variant="outline">
                  <Code className="h-5 w-5" />
                </Button>
                <Button className="hover:border-purple-200 hover:bg-purple-50" size="icon" variant="outline">
                  <Users className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <div className="space-y-4">
              <h4 className="text-foreground text-lg font-semibold">Platform</h4>
              <ul className="text-muted-foreground space-y-3">
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    Browse APIs
                  </a>
                </li>
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    Publish API
                  </a>
                </li>
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    API Testing
                  </a>
                </li>
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    Documentation
                  </a>
                </li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="text-foreground text-lg font-semibold">Company</h4>
              <ul className="text-muted-foreground space-y-3">
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    About
                  </a>
                </li>
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    Careers
                  </a>
                </li>
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    Contact
                  </a>
                </li>
                <li>
                  <a className="hover:text-foreground transition-colors" href="#">
                    Blog
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-border/40 mt-16 flex flex-col items-center justify-between border-t pt-8 md:flex-row">
            <p className="text-muted-foreground">© 2025 Zevium API Hub. All rights reserved.</p>
            <div className="text-muted-foreground mt-4 flex space-x-8 md:mt-0">
              <a className="hover:text-foreground transition-colors" href="#">
                Privacy Policy
              </a>
              <a className="hover:text-foreground transition-colors" href="#">
                Terms of Service
              </a>
              <a className="hover:text-foreground transition-colors" href="#">
                Support
              </a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
