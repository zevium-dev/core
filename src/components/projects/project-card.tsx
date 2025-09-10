import { Link } from "@tanstack/react-router";
import { 
  Activity,
  Building2,
  Clock, 
  ExternalLink,
  Globe,
  Lock,
  MoreHorizontal, 
  Settings, 
  Users
} from "lucide-react";
import { m } from "motion/react";

import { BadgeStatus } from "~/components/ui/badge-status";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

interface ProjectCardProps {
  project: ProjectFromAPI;
  variant?: "compact" | "default";
}

// Actual API response project type with optional metrics
interface ProjectFromAPI {
  apiSpecCount?: number;
  createdAt: Date;
  createdBy: string;
  creatorName: string;
  description: null | string;
  id: string;
  memberCount?: number;
  metadata: Record<string, unknown>;
  name: string;
  settings: Record<string, unknown>;
  slug: string;
  status: "active" | "archived" | "beta" | "deprecated" | "inactive";
  updatedAt: Date;
  visibility: "internal" | "private" | "public";
}

export function ProjectCard({ project, variant = "default" }: ProjectCardProps) {
  const timeAgo = getTimeAgo(project.updatedAt);
  const visibilityInfo = getVisibilityInfo(project.visibility);
  
  // Use real metrics from the database with fallbacks
  const metrics = {
    endpointCount: project.apiSpecCount ?? 0,
    memberCount: project.memberCount ?? 1, // Default to 1 (the creator)
  };

  if (variant === "compact") {
    return (
      <m.div
        animate={{ opacity: 1, y: 0 }}
        initial={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        whileHover={{ y: -2 }}
      >
        <Link params={{ slug: project.slug }} to="/projects/$slug">
          <Card className="group relative overflow-hidden border-border/40 bg-gradient-to-br from-card via-card to-card/95 transition-all duration-300 hover:shadow-xl hover:border-border/80 cursor-pointer">
            {/* Status indicator stripe */}
            <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${
              project.status === "active" ? "from-green-500 to-emerald-400" :
              project.status === "beta" ? "from-blue-500 to-indigo-400" :
              project.status === "deprecated" ? "from-orange-500 to-amber-400" :
              "from-gray-500 to-slate-400"
            }`} />
            
            <CardHeader className="pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex items-center gap-3 justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <CardTitle className="text-lg font-bold leading-tight truncate group-hover:text-primary transition-colors">
                        {project.name}
                      </CardTitle>
                      <BadgeStatus status={project.status} />
                    </div>
                    <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                      <span className="font-medium">{project.creatorName}</span>
                      <span className="text-muted-foreground">•</span>
                      <span>Created {new Date(project.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <CardDescription className="text-sm leading-relaxed line-clamp-3">
                    {project.description ?? "No description available"}
                  </CardDescription>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity data-[state=open]:opacity-100" 
                      onClick={(e) => e.preventDefault()}
                      variant="ghost"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Project options</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[160px]">
                    <DropdownMenuItem>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      View Project
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      <Settings className="mr-2 h-4 w-4" />
                      Settings
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            
            <CardContent className="pt-0">
              <div className="grid grid-cols-4 gap-3 text-sm mb-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-green-500" />
                    <span className="font-medium">Endpoints</span>
                  </div>
                  <span className="text-sm font-semibold">{metrics.endpointCount}</span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-purple-500" />
                    <span className="font-medium">Members</span>
                  </div>
                  <span className="text-sm font-semibold">{metrics.memberCount}</span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-amber-500" />
                    <span className="font-medium">Updated</span>
                  </div>
                  <span className="text-sm font-semibold">{timeAgo}</span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <visibilityInfo.icon className={`h-4 w-4 ${visibilityInfo.color}`} />
                    <span className="text-sm font-medium">Visibility</span>
                  </div>
                  <span className="text-sm font-semibold capitalize">{visibilityInfo.label}</span>
                </div>
              </div>
              
              {/* compact variant: creator/date displayed in header */}
            </CardContent>
          </Card>
        </Link>
      </m.div>
    );
  }

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      initial={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      whileHover={{ y: -4 }}
    >
      <Link params={{ slug: project.slug }} to="/projects/$slug">
        <Card className="group relative overflow-hidden border-border/40 bg-gradient-to-br from-card via-card to-card/95 transition-all duration-300 hover:shadow-2xl hover:border-border/80 cursor-pointer h-full">
          {/* Status indicator stripe */}
          <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${
            project.status === "active" ? "from-green-500 to-emerald-400" :
            project.status === "beta" ? "from-blue-500 to-indigo-400" :
            project.status === "deprecated" ? "from-orange-500 to-amber-400" :
            "from-gray-500 to-slate-400"
          }`} />
          
          <CardHeader className="">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-3 flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-xl font-bold leading-tight truncate group-hover:text-primary transition-colors">
                    {project.name}
                  </CardTitle>
                  <BadgeStatus status={project.status} />
                </div>
                <CardDescription className="text-sm leading-relaxed line-clamp-3 text-muted-foreground">
                  {project.description ?? "No description available"}
                </CardDescription>
                
                {/* Creator and creation date on the same line (concise) */}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="text-xs font-medium truncate">{project.creatorName}</span>
                  <span className="text-xs text-muted-foreground">•</span>
                  <span className="text-xs">Created {new Date(project.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button 
                    className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity data-[state=open]:opacity-100" 
                    onClick={(e) => e.preventDefault()}
                    variant="ghost"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Project options</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[160px]">
                  <DropdownMenuItem>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View Project
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          
          <CardContent className="pt-0">
            {/* Metrics grid - standardized boxes */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">Endpoints</span>
                  </div>
                  <span className="text-sm font-semibold">{metrics.endpointCount}</span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-purple-500" />
                    <span className="text-sm font-medium">Members</span>
                  </div>
                  <span className="text-sm font-semibold">{metrics.memberCount}</span>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-amber-500" />
                    <span className="text-sm font-medium">Updated</span>
                  </div>
                  <span className="text-sm font-semibold">{timeAgo}</span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/40 h-12">
                  <div className="flex items-center gap-2">
                    <visibilityInfo.icon className={`h-4 w-4 ${visibilityInfo.color}`} />
                    <span className="text-sm font-medium">Visibility</span>
                  </div>
                  <span className={`text-sm font-semibold capitalize ${visibilityInfo.color}`}>{visibilityInfo.label}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    </m.div>
  );
}

// Utility function for time formatting
function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return "0m ago";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  return `${Math.floor(diffInSeconds / 86400)}d ago`;
}

// Helper function to get visibility icon and styling
function getVisibilityInfo(visibility: string) {
  switch (visibility) {
    case "internal":
      return { color: "text-blue-600", icon: Building2, label: "Internal" };
    case "public":
      return { color: "text-green-600", icon: Globe, label: "Public" };
    case "private":
    default:
      return { color: "text-amber-600", icon: Lock, label: "Private" };
  }
}
