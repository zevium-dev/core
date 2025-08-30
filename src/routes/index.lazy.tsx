import { createLazyFileRoute } from "@tanstack/react-router";
import { ArrowRight, Code, BarChart3, Zap, Users, Globe, TrendingUp, Star, FileText, MessageSquare, Folder, Bot } from "lucide-react";
import React, { forwardRef, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { PageHeaderContent } from "~/components/sidebar";
import { cn } from "~/lib/utils";
import { AnimatedBeam } from "~/components/magicui/animated-beam";
import { Ripple } from "~/components/magicui/ripple";
import { WordRotate } from "~/components/magicui/word-rotate";

export const Route = createLazyFileRoute("/")({
  component: Home,
});

const Circle = forwardRef<
  HTMLDivElement,
  { className?: string; children?: React.ReactNode }
>(({ className, children }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "z-10 flex size-12 items-center justify-center rounded-full border-2 bg-white p-3 shadow-[0_0_20px_-12px_rgba(0,0,0,0.8)]",
        className,
      )}
    >
      {children}
    </div>
  );
});

Circle.displayName = "Circle";

function AnimatedBeamDemo({
  className,
}: {
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const div1Ref = useRef<HTMLDivElement>(null);
  const div2Ref = useRef<HTMLDivElement>(null);
  const div3Ref = useRef<HTMLDivElement>(null);
  const div4Ref = useRef<HTMLDivElement>(null);
  const div5Ref = useRef<HTMLDivElement>(null);
  const div6Ref = useRef<HTMLDivElement>(null);
  const div7Ref = useRef<HTMLDivElement>(null);

  return (
    <div
      className={cn(
        "relative flex h-[500px] w-full items-center justify-center overflow-hidden p-10",
        className,
      )}
      ref={containerRef}
    >
      <div className="flex size-full max-w-lg flex-row items-stretch justify-between gap-10">
        <div className="flex flex-col justify-center">
          <Circle ref={div7Ref}>
            <Users className="h-6 w-6" />
          </Circle>
        </div>
        <div className="flex flex-col justify-center">
          <Circle ref={div6Ref} className="size-16">
            <Bot className="h-8 w-8" />
          </Circle>
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Circle ref={div1Ref}>
            <Folder className="h-6 w-6" />
          </Circle>
          <Circle ref={div2Ref}>
            <FileText className="h-6 w-6" />
          </Circle>
          <Circle ref={div3Ref}>
            <MessageSquare className="h-6 w-6" />
          </Circle>
          <Circle ref={div4Ref}>
            <Globe className="h-6 w-6" />
          </Circle>
          <Circle ref={div5Ref}>
            <Code className="h-6 w-6" />
          </Circle>
        </div>
      </div>

      {/* AnimatedBeams */}
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={div1Ref}
        toRef={div6Ref}
        duration={3}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={div2Ref}
        toRef={div6Ref}
        duration={3}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={div3Ref}
        toRef={div6Ref}
        duration={3}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={div4Ref}
        toRef={div6Ref}
        duration={3}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={div5Ref}
        toRef={div6Ref}
        duration={3}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={div6Ref}
        toRef={div7Ref}
        duration={3}
      />
    </div>
  );
}

function Home() {
  return (
    <>
      <PageHeaderContent>
        <div className="flex items-center gap-4 w-full">
          <div className="flex items-center space-x-2">
            <Globe className="h-5 w-5 text-blue-600" />
            <span className="font-semibold">API Hub Dashboard</span>
          </div>
          <div className="ml-auto flex items-center space-x-2">
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
              Get started
            </Button>
          </div>
        </div>
      </PageHeaderContent>

      <div className="flex-1 space-y-8 p-4 md:p-8 pt-6">
        {/* Hero Section */}
        <section className="relative py-16 overflow-hidden">
          <Ripple />
          <div className="relative z-10 space-y-12">
            <div className="text-center space-y-6 max-w-4xl mx-auto">
              <h1 className="text-4xl lg:text-6xl font-bold text-foreground leading-tight">
                Integrate{" "}
                <WordRotate
                  className="inline text-4xl lg:text-6xl font-bold text-blue-600"
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
                    "file uploads"
                  ]}
                  duration={3000}
                />{" "}
                in one click
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl mx-auto">
                Connect any API faster, securely, and reliably through Zevium. 
                <br />
                Our unified gateway simplifies integration, reduces complexity, 
                and accelerates your development workflow.
              </p>
              <Button size="lg" className="bg-blue-600 hover:bg-blue-700">
                API hub
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
            <div className="flex justify-center">
              <AnimatedBeamDemo />
            </div>
          </div>
        </section>

        {/* Stats Section */}
        <section className="py-20 bg-muted/30 rounded-2xl">
          <div className="text-center space-y-16">
            <div className="space-y-4">
              <h2 className="text-4xl lg:text-6xl font-bold text-foreground">
                World's largest public
              </h2>
              <h2 className="text-4xl lg:text-6xl font-bold text-foreground">
                API Hub
              </h2>
            </div>
            
            <div className="grid md:grid-cols-3 gap-12">
              <div className="text-center group cursor-pointer">
                <div className="inline-flex items-center justify-center w-20 h-20 bg-blue-100 dark:bg-blue-900/20 rounded-full mb-6 group-hover:scale-110 transition-transform duration-300">
                  <Users className="h-10 w-10 text-blue-600" />
                </div>
                <div className="text-5xl lg:text-7xl font-bold text-foreground mb-3">7M+</div>
                <p className="text-blue-600 font-semibold text-lg">Developers</p>
              </div>
              <div className="text-center group cursor-pointer">
                <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 dark:bg-green-900/20 rounded-full mb-6 group-hover:scale-110 transition-transform duration-300">
                  <Code className="h-10 w-10 text-green-600" />
                </div>
                <div className="text-5xl lg:text-7xl font-bold text-foreground mb-3">75K+</div>
                <p className="text-green-600 font-semibold text-lg">APIs in the Hub</p>
              </div>
              <div className="text-center group cursor-pointer">
                <div className="inline-flex items-center justify-center w-20 h-20 bg-purple-100 dark:bg-purple-900/20 rounded-full mb-6 group-hover:scale-110 transition-transform duration-300">
                  <TrendingUp className="h-10 w-10 text-purple-600" />
                </div>
                <div className="text-5xl lg:text-7xl font-bold text-foreground mb-3">8B+</div>
                <p className="text-purple-600 font-semibold text-lg">API calls per month</p>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="py-20 space-y-24">
          {/* Publish APIs */}
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <Card className="bg-gray-900 dark:bg-gray-950 text-white border-gray-700 shadow-2xl">
                <CardHeader className="pb-4">
                  <div className="flex items-center gap-3 mb-4">
                    <Badge variant="secondary" className="bg-blue-100 text-blue-900 px-3 py-1">
                      Node.js Axios
                    </Badge>
                    <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                      Copy Code
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="font-mono text-sm space-y-1">
                  <div className="text-blue-400">const axios = require('axios');</div>
                  <div className="text-yellow-400">const options = {'{'};</div>
                  <div className="ml-4 text-green-400">method: 'GET',</div>
                  <div className="ml-4 text-green-400">url: 'https://example-api-url.in-game.ra...',</div>
                  <div className="ml-4 text-purple-400">params: {'{'}</div>
                  <div className="ml-8 text-orange-400">projectSlugType: '2'</div>
                  <div className="ml-4 text-purple-400">{'},'}</div>
                  <div className="ml-4 text-blue-400">headers: {'{'}</div>
                  <div className="ml-8 text-green-400">'X-RapidAPI-Key': 'API-KEY-HERE',</div>
                  <div className="ml-8 text-green-400">'X-RapidAPI-Host': 'example-in-live-sc...'</div>
                  <div className="ml-4 text-blue-400">{'}'}</div>
                  <div className="text-yellow-400">{'};'}</div>
                  <div className="mt-4 text-blue-400">try {'{'}</div>
                  <div className="ml-4 text-green-400">const response = await axios.request(options);</div>
                  <div className="ml-4 text-green-400">console.log(response.data);</div>
                  <div className="text-blue-400">{'} catch (error) {'}</div>
                  <div className="ml-4 text-red-400">console.error(error);</div>
                  <div className="text-blue-400">{'}'}</div>
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="bg-blue-100 dark:bg-blue-900/20 p-3 rounded-xl">
                  <Zap className="h-8 w-8 text-blue-600" />
                </div>
                <h3 className="text-4xl font-bold text-foreground">Publish APIs</h3>
              </div>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Track subscriptions, highlight instructional content. Drive engagement. 
                <strong className="text-foreground"> Monetize APIs</strong>
              </p>
            </div>
          </div>

          {/* Consume APIs */}
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="space-y-6 order-2 lg:order-1">
              <div className="flex items-center gap-4">
                <div className="bg-green-100 dark:bg-green-900/20 p-3 rounded-xl">
                  <Globe className="h-8 w-8 text-green-600" />
                </div>
                <h3 className="text-4xl font-bold text-foreground">Consume APIs</h3>
              </div>
              <p className="text-lg text-muted-foreground leading-relaxed">
                With indexed search functionality, discovering the perfect API match for 
                your product roadmap is easier than ever.
              </p>
            </div>
            <div className="order-1 lg:order-2">
              <Card className="bg-white dark:bg-gray-900 border shadow-2xl">
                <CardContent className="p-8">
                  <div className="space-y-6">
                    <div className="flex items-center gap-3">
                      <div className="w-4 h-4 bg-red-500 rounded-full"></div>
                      <div className="w-4 h-4 bg-yellow-500 rounded-full"></div>
                      <div className="w-4 h-4 bg-green-500 rounded-full"></div>
                    </div>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 bg-gray-300 dark:bg-gray-600 rounded"></div>
                        <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded flex-1"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 bg-blue-500 rounded"></div>
                        <div className="h-3 bg-blue-500 rounded w-2/3"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 bg-gray-300 dark:bg-gray-600 rounded"></div>
                        <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-1/2"></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 bg-purple-500 rounded"></div>
                        <div className="h-3 bg-purple-500 rounded w-3/4"></div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Manage APIs */}
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <Card className="bg-white dark:bg-gray-900 border shadow-2xl">
                <CardContent className="p-8">
                  <div className="space-y-6">
                    <div className="flex justify-between items-center">
                      <Badge variant="outline" className="px-3 py-1">General Settings</Badge>
                      <div className="text-sm text-muted-foreground font-medium">100%</div>
                    </div>
                    <div className="space-y-5">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">API Calls</span>
                          <span className="text-sm font-bold">8.8/10</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                          <div className="bg-green-500 h-3 rounded-full transition-all duration-500" style={{width: '88%'}}></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">Performance</span>
                          <span className="text-sm font-bold">100%</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                          <div className="bg-green-500 h-3 rounded-full transition-all duration-500 w-full"></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm font-medium">Uptime</span>
                          <span className="text-sm font-bold">99.9%</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                          <div className="bg-blue-500 h-3 rounded-full transition-all duration-500" style={{width: '99%'}}></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="bg-purple-100 dark:bg-purple-900/20 p-3 rounded-xl">
                  <BarChart3 className="h-8 w-8 text-purple-600" />
                </div>
                <h3 className="text-4xl font-bold text-foreground">Manage APIs</h3>
              </div>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Never wonder how many APIs you have or how they're being used. Instead, surface 
                performance and usage patterns instantly and keep a birds-eye view of your{' '}
                <strong className="text-foreground">API ecosystem</strong>.
              </p>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border/40 py-20 mt-20">
          <div className="grid md:grid-cols-4 gap-12">
            <div className="col-span-2 space-y-6">
              <div className="flex items-center space-x-3">
                <Globe className="h-8 w-8 text-blue-600" />
                <span className="font-bold text-2xl">Zevium API Hub</span>
              </div>
              <p className="text-muted-foreground max-w-md leading-relaxed">
                The world's largest public API hub. Discover, consume, and manage APIs 
                with ease. Build the future with our comprehensive API ecosystem.
              </p>
              <div className="flex space-x-3">
                <Button variant="outline" size="icon" className="hover:bg-blue-50 hover:border-blue-200">
                  <Globe className="h-5 w-5" />
                </Button>
                <Button variant="outline" size="icon" className="hover:bg-green-50 hover:border-green-200">
                  <Code className="h-5 w-5" />
                </Button>
                <Button variant="outline" size="icon" className="hover:bg-purple-50 hover:border-purple-200">
                  <Users className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold text-foreground text-lg">Platform</h4>
              <ul className="space-y-3 text-muted-foreground">
                <li><a href="#" className="hover:text-foreground transition-colors">Browse APIs</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Publish API</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">API Testing</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Documentation</a></li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold text-foreground text-lg">Company</h4>
              <ul className="space-y-3 text-muted-foreground">
                <li><a href="#" className="hover:text-foreground transition-colors">About</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Careers</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Contact</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Blog</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-border/40 mt-16 pt-8 flex flex-col md:flex-row justify-between items-center">
            <p className="text-muted-foreground">
              © 2025 Zevium API Hub. All rights reserved.
            </p>
            <div className="flex space-x-8 text-muted-foreground mt-4 md:mt-0">
              <a href="#" className="hover:text-foreground transition-colors">Privacy Policy</a>
              <a href="#" className="hover:text-foreground transition-colors">Terms of Service</a>
              <a href="#" className="hover:text-foreground transition-colors">Support</a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
