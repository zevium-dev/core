import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, Database, Globe, Search, Shield, Users, Zap } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { useTRPCClient } from "~/lib/trpc";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/app/catalogue")({
  component: RouteComponent,
});

// Type for category data from TRPC
interface CategoryData {
  createdAt: Date;
  description: null | string;
  icon: null | string;
  id: string;
  name: string;
  updatedAt: Date;
  weight: number;
}

// Helper function to get category icon
const getCategoryIcon = (iconName: null | string) => {
  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    activity: Activity,
    database: Database,
    globe: Globe,
    shield: Shield,
    users: Users,
    zap: Zap,
  };

  return iconMap[iconName?.toLowerCase() ?? ""] ?? Database;
};

// Type for project data from TRPC
interface ProjectData {
  apiSpecCount: number;
  categoryId: null | string;
  categoryName: null | string;
  createdAt: Date;
  createdBy: string;
  creatorName: string;
  description: null | string;
  id: string;
  memberCount: number;
  metadata: Record<string, unknown>;
  name: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  settings: Record<string, unknown>;
  slug: string;
  status: "active" | "archived" | "beta" | "deprecated" | "inactive";
  updatedAt: Date;
  visibility: "internal" | "private" | "public";
}

function APICard({ api }: { api: ProjectData }) {
  return (
    <Card className="group border-border/40 hover:border-border bg-card/30 hover:bg-card/60 hover:shadow-primary/5 flex h-full cursor-pointer flex-col backdrop-blur-sm transition-all duration-300 hover:shadow-xl">
      <CardHeader className="">
        <div className="space-y-4">
          {/* Title and Category */}
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-foreground group-hover:text-primary line-clamp-2 text-xl leading-tight font-bold transition-colors">
                {api.name}
              </h3>
              {api.categoryName && (
                <Badge className="shrink-0 text-xs font-medium" variant="secondary">
                  {api.categoryName}
                </Badge>
              )}
            </div>

            {/* Organization */}
            <div className="text-muted-foreground text-sm">
              <span className="text-foreground/80 font-medium">{api.organizationName}</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col pt-0">
        {/* Description */}
        <div className="mb-6 flex-1">
          <p className="text-muted-foreground line-clamp-3 text-sm leading-relaxed">
            {api.description ?? "No description available"}
          </p>
        </div>

        {/* Footer - Updated At */}
        <div className="border-border/30 mt-auto border-t pt-4">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>Last updated</span>
            <time className="text-foreground/70 font-medium">
              {api.updatedAt.toLocaleDateString("en-US", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </time>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CategorySidebar({
  categories,
  onCategoryChange,
  projectCounts,
  selectedCategory,
}: {
  categories: Array<CategoryData>;
  onCategoryChange: (category: string) => void;
  projectCounts: Record<string, number>;
  selectedCategory: string;
}) {
  // Add "All Projects" as the first option
  const allCategories = [
    {
      count: Object.values(projectCounts).reduce((sum, count) => sum + count, 0),
      icon: Globe,
      id: "all",
      name: "All Projects",
    },
    ...categories.map((category) => ({
      count: projectCounts[category.id] ?? 0,
      icon: getCategoryIcon(category.icon),
      id: category.id,
      name: category.name,
    })),
  ];

  return (
    <aside className="w-64 shrink-0 space-y-3">
      <h2 className="text-muted-foreground px-3 text-sm font-semibold tracking-wide uppercase">Categories</h2>

      <nav className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent max-h-100 space-y-1 overflow-y-auto px-2">
        {allCategories.map((category) => {
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

  const trpcClient = useTRPCClient();

  // Fetch data using React Query
  const categoriesQuery = useQuery({
    queryFn: () => trpcClient.projectCategory.getAll.query({}),
    queryKey: ["projectCategory", "getAll"],
  });

  const projectsQuery = useQuery({
    queryFn: () => trpcClient.project.getUserProjects.query(),
    queryKey: ["project", "getUserProjects"],
  });

  // Calculate project counts per category
  const projectCounts = useMemo(() => {
    if (!projectsQuery.data) return {};

    const counts: Record<string, number> = {};
    projectsQuery.data.projects.forEach((project) => {
      const categoryId = project.categoryId ?? "uncategorized";
      counts[categoryId] = (counts[categoryId] || 0) + 1;
    });
    return counts;
  }, [projectsQuery.data]);

  // Filter projects based on category and search
  const filteredProjects = useMemo(() => {
    if (!projectsQuery.data) return [];

    let filtered = projectsQuery.data.projects;

    // Filter by category
    if (selectedCategory !== "all") {
      filtered = filtered.filter((project) => project.categoryId === selectedCategory);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (project) =>
          project.name.toLowerCase().includes(query) ||
          (project.description ?? "").toLowerCase().includes(query) ||
          project.organizationName.toLowerCase().includes(query) ||
          (project.categoryName ?? "").toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [projectsQuery.data, searchQuery, selectedCategory]);

  // Get category name for display
  const selectedCategoryName = useMemo(() => {
    if (selectedCategory === "all") return null;
    return categoriesQuery.data?.categories.find((c) => c.id === selectedCategory)?.name;
  }, [categoriesQuery.data, selectedCategory]);

  // Loading states
  if (categoriesQuery.isLoading || projectsQuery.isLoading) {
    return (
      <div className="bg-background min-h-screen">
        <header className="border-border/50 bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
            <div className="space-y-6">
              <div className="space-y-2">
                <h1 className="text-foreground text-2xl font-bold tracking-tight sm:text-3xl">API Catalogue</h1>
                <p className="text-muted-foreground text-sm sm:text-base">
                  Discover and integrate powerful APIs to enhance your applications
                </p>
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="py-16 text-center">
            <div className="mx-auto max-w-md">
              <Database className="text-muted-foreground mx-auto mb-6 size-16" />
              <h3 className="text-foreground mb-3 text-xl font-semibold">Loading...</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Fetching categories and projects from the database.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Error states
  if (categoriesQuery.error || projectsQuery.error) {
    return (
      <div className="bg-background min-h-screen">
        <header className="border-border/50 bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
            <div className="space-y-6">
              <div className="space-y-2">
                <h1 className="text-foreground text-2xl font-bold tracking-tight sm:text-3xl">API Catalogue</h1>
                <p className="text-muted-foreground text-sm sm:text-base">
                  Discover and integrate powerful APIs to enhance your applications
                </p>
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="py-16 text-center">
            <div className="mx-auto max-w-md">
              <Database className="text-muted-foreground mx-auto mb-6 size-16" />
              <h3 className="text-foreground mb-3 text-xl font-semibold">Error loading data</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Failed to load data from the database. Please try again later.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const categories = categoriesQuery.data?.categories ?? [];
  const allCategories = [
    {
      count: Object.values(projectCounts).reduce((sum, count) => sum + count, 0),
      icon: Globe,
      id: "all",
      name: "All Projects",
    },
    ...categories.map((category) => ({
      count: projectCounts[category.id] ?? 0,
      icon: getCategoryIcon(category.icon),
      id: category.id,
      name: category.name,
    })),
  ];

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
                placeholder="Search projects, organizations, or categories..."
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
            <CategorySidebar
              categories={categories}
              onCategoryChange={setSelectedCategory}
              projectCounts={projectCounts}
              selectedCategory={selectedCategory}
            />
          </div>

          {/* Mobile Category Filter */}
          <div className="mb-6 lg:hidden">
            <div className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent flex gap-2 overflow-x-auto pb-2">
              {allCategories.map((category) => {
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

          {/* Project Grid */}
          <div className="min-w-0 flex-1">
            {filteredProjects.length > 0 ? (
              <>
                <div className="mb-6 flex items-center justify-between">
                  <p className="text-muted-foreground text-sm">
                    Showing {filteredProjects.length} {filteredProjects.length === 1 ? "project" : "projects"}
                    {selectedCategoryName && <span className="ml-1">in {selectedCategoryName}</span>}
                  </p>
                </div>

                <div className="grid auto-rows-fr grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {filteredProjects.map((project) => (
                    <APICard api={project} key={project.id} />
                  ))}
                </div>
              </>
            ) : (
              <div className="py-16 text-center">
                <div className="mx-auto max-w-md">
                  <Database className="text-muted-foreground mx-auto mb-6 size-16" />
                  <h3 className="text-foreground mb-3 text-xl font-semibold">No projects found</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    Try adjusting your search criteria or browse different categories to discover more projects.
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
