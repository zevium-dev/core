import { createLazyFileRoute } from "@tanstack/react-router";
import { Activity, Clock, Database, Globe, Search, Shield, TrendingUp, Users, Zap } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export const Route = createLazyFileRoute("/catalogue")({
  component: RouteComponent,
});

// Mock data for demonstration
const mockAPIs = [
  {
    callCount: 45672,
    category: "Financial Services",
    description: "Secure payment processing with support for multiple currencies and payment methods",
    id: 1,
    latency: 120,
    provider: "PaySecure Inc.",
    successRate: 99.8,
    tags: ["payment", "security", "fintech"],
    title: "Payment Gateway API",
  },
  {
    callCount: 128943,
    category: "Data & Analytics",
    description: "Real-time weather data and forecasting for any location worldwide",
    id: 2,
    latency: 85,
    provider: "WeatherTech",
    successRate: 99.5,
    tags: ["weather", "forecast", "geolocation"],
    title: "Weather Forecast API",
  },
  {
    callCount: 89234,
    category: "Security",
    description: "OAuth 2.0 and JWT-based authentication service with social login support",
    id: 3,
    latency: 95,
    provider: "AuthFlow Solutions",
    successRate: 99.9,
    tags: ["auth", "oauth", "security"],
    title: "User Authentication API",
  },
  {
    callCount: 34567,
    category: "Machine Learning",
    description: "AI-powered image analysis, recognition, and transformation services",
    id: 4,
    latency: 245,
    provider: "VisionAI Corp",
    successRate: 98.7,
    tags: ["ai", "image", "processing"],
    title: "Image Processing API",
  },
  {
    callCount: 67890,
    category: "Communication",
    description: "Reliable transactional and bulk email delivery with analytics",
    id: 5,
    latency: 110,
    provider: "MailStream",
    successRate: 99.6,
    tags: ["email", "delivery", "analytics"],
    title: "Email Delivery API",
  },
  {
    callCount: 156789,
    category: "Data & Analytics",
    description: "Precise IP-based and GPS geolocation services with address lookup",
    id: 6,
    latency: 75,
    provider: "GeoPoint Systems",
    successRate: 99.4,
    tags: ["location", "gps", "mapping"],
    title: "Geolocation API",
  },
];

const categories = [
  { count: mockAPIs.length, icon: Globe, id: "all", name: "All APIs" },
  { count: 1, icon: Shield, id: "financial", name: "Financial Services" },
  { count: 2, icon: Database, id: "data", name: "Data & Analytics" },
  { count: 1, icon: Shield, id: "security", name: "Security" },
  { count: 1, icon: Zap, id: "ml", name: "Machine Learning" },
  { count: 1, icon: Users, id: "communication", name: "Communication" },
];

function APICard({ api }: { api: (typeof mockAPIs)[0] }) {
  return (
    <Card className="group border-border/50 hover:border-border bg-card/50 flex h-full cursor-pointer flex-col backdrop-blur-sm transition-all duration-300 hover:shadow-lg">
      <CardHeader className="pb-6">
        <div className="space-y-3">
          {/* Title and Category Badge */}
          <div className="flex items-start justify-between gap-4">
            <h3 className="text-foreground group-hover:text-primary text-lg leading-tight font-semibold transition-colors">
              {api.title}
            </h3>
            <Badge className="shrink-0" variant="outline">
              {api.category}
            </Badge>
          </div>

          {/* Provider */}
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>by</span>
            <span className="text-foreground font-medium">{api.provider}</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col pt-0 pb-6">
        {/* Description - Full Width */}
        <div className="mb-6">
          <CardDescription className="text-sm leading-relaxed">{api.description}</CardDescription>
        </div>

        {/* Spacer to push footer content to bottom */}
        <div className="flex-1"></div>

        {/* Footer Content - Tags and Metrics */}
        <div className="space-y-4">
          {/* Tags */}
          <div className="flex flex-wrap gap-1.5">
            {api.tags.map((tag) => (
              <Badge className="px-2 py-0.5 text-xs" key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>

          {/* Metrics */}
          <div className="border-border/50 grid grid-cols-3 gap-4 border-t pt-4">
            <div className="text-center">
              <div className="text-muted-foreground mb-1.5 flex items-center justify-center gap-1">
                <Activity className="size-3" />
                <span className="text-xs font-medium">Calls</span>
              </div>
              <div className="text-foreground text-sm font-semibold">{api.callCount.toLocaleString()}</div>
            </div>

            <div className="text-center">
              <div className="text-muted-foreground mb-1.5 flex items-center justify-center gap-1">
                <Clock className="size-3" />
                <span className="text-xs font-medium">Latency</span>
              </div>
              <div className="text-foreground text-sm font-semibold">{api.latency}ms</div>
            </div>

            <div className="text-center">
              <div className="text-muted-foreground mb-1.5 flex items-center justify-center gap-1">
                <TrendingUp className="size-3" />
                <span className="text-xs font-medium">Success</span>
              </div>
              <div className="text-sm font-semibold text-green-600 dark:text-green-400">{api.successRate}%</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CategorySidebar({
  onCategoryChange,
  selectedCategory,
}: {
  onCategoryChange: (category: string) => void;
  selectedCategory: string;
}) {
  return (
    <aside className="w-64 shrink-0 space-y-3">
      <h2 className="text-muted-foreground px-3 text-sm font-semibold tracking-wide uppercase">Categories</h2>

      <nav className="space-y-1 px-2">
        {categories.map((category) => {
          const Icon = category.icon;
          const isActive = selectedCategory === category.id;

          return (
            <Button
              className={cn(
                "h-11 w-full justify-start gap-3 rounded-lg px-3 transition-all duration-200",
                isActive
                  ? "bg-primary/10 text-primary border-primary border-r-2 shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              key={category.id}
              onClick={() => onCategoryChange(category.id)}
              variant="ghost"
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1 truncate text-left font-medium">{category.name}</span>
              <Badge
                className="h-5 min-w-[1.75rem] px-2 py-0.5 text-xs font-medium"
                variant={isActive ? "default" : "secondary"}
              >
                {category.count}
              </Badge>
            </Button>
          );
        })}
      </nav>
    </aside>
  );
}

function RouteComponent() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  const filteredAPIs = useMemo(() => {
    let filtered = mockAPIs;

    // Filter by category
    if (selectedCategory !== "all") {
      const categoryMap: Record<string, string> = {
        communication: "Communication",
        data: "Data & Analytics",
        financial: "Financial Services",
        ml: "Machine Learning",
        security: "Security",
      };
      filtered = filtered.filter((api) => api.category === categoryMap[selectedCategory]);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (api) =>
          api.title.toLowerCase().includes(query) ||
          api.description.toLowerCase().includes(query) ||
          api.provider.toLowerCase().includes(query) ||
          api.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }

    return filtered;
  }, [searchQuery, selectedCategory]);

  return (
    <div className="bg-background min-h-screen">
      {/* Header */}
      <header className="border-border/50 bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-foreground text-2xl font-bold tracking-tight sm:text-3xl">API Catalogue</h1>
              <p className="text-muted-foreground text-sm sm:text-base">
                Discover and integrate powerful APIs to enhance your applications
              </p>
            </div>

            {/* Search Bar */}
            <div className="relative max-w-full sm:max-w-md lg:max-w-lg xl:max-w-xl">
              <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2 transform" />
              <Input
                className="bg-background/50 border-border/50 focus:border-primary/50 h-11 pl-10 text-sm"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search APIs, providers, or technologies..."
                value={searchQuery}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-8 lg:flex-row">
          {/* Sidebar - Hidden on mobile, shown as drawer if needed */}
          <div className="hidden lg:block">
            <CategorySidebar onCategoryChange={setSelectedCategory} selectedCategory={selectedCategory} />
          </div>

          {/* Mobile Category Filter */}
          <div className="mb-6 lg:hidden">
            <div className="scrollbar-hide flex gap-2 overflow-x-auto pb-2">
              {categories.map((category) => {
                const Icon = category.icon;
                const isActive = selectedCategory === category.id;

                return (
                  <Button
                    className={cn(
                      "h-9 shrink-0 gap-2 rounded-full px-4",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
                    )}
                    key={category.id}
                    onClick={() => setSelectedCategory(category.id)}
                    size="sm"
                  >
                    <Icon className="size-3" />
                    <span className="text-xs font-medium">{category.name}</span>
                    <Badge
                      className="h-4 min-w-[1rem] px-1.5 py-0 text-xs"
                      variant={isActive ? "secondary" : "outline"}
                    >
                      {category.count}
                    </Badge>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* API Grid */}
          <div className="min-w-0 flex-1">
            {filteredAPIs.length > 0 ? (
              <>
                <div className="mb-6 flex items-center justify-between">
                  <p className="text-muted-foreground text-sm">
                    Showing {filteredAPIs.length} {filteredAPIs.length === 1 ? "API" : "APIs"}
                    {selectedCategory !== "all" && (
                      <span className="ml-1">in {categories.find((c) => c.id === selectedCategory)?.name}</span>
                    )}
                  </p>
                </div>

                <div className="grid auto-rows-fr grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {filteredAPIs.map((api) => (
                    <APICard api={api} key={api.id} />
                  ))}
                </div>
              </>
            ) : (
              <div className="py-16 text-center">
                <div className="mx-auto max-w-md">
                  <Database className="text-muted-foreground mx-auto mb-6 size-16" />
                  <h3 className="text-foreground mb-3 text-xl font-semibold">No APIs found</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    Try adjusting your search criteria or browse different categories to discover more APIs.
                  </p>
                  {searchQuery && (
                    <Button className="mt-4" onClick={() => setSearchQuery("")} variant="outline">
                      Clear search
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
