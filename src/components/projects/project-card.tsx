import { Link } from "@tanstack/react-router";
import { 
  Building2, 
  Clock, 
  ExternalLink, 
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
  organizationName: string;
  project: ProjectFromAPI;
  variant?: "compact" | "default";
}

// Actual API response project type
interface ProjectFromAPI {
  createdAt: Date;
  createdBy: string;
  creatorName: string;
  description: null | string;
  id: string;
  metadata: Record<string, unknown>;
  name: string;
  settings: Record<string, unknown>;
  slug: string;
  status: "active" | "archived" | "beta" | "deprecated" | "inactive";
  updatedAt: Date;
  visibility: "internal" | "private" | "public";
}

export function ProjectCard({ organizationName, project, variant = "default" }: ProjectCardProps) {
  const timeAgo = getTimeAgo(project.updatedAt);
  
  // Generate placeholder data for metrics not yet in database
  const placeholderMetrics = {
    endpointCount: Math.floor(Math.random() * 25) + 5,
    memberCount: Math.floor(Math.random() * 12) + 1,
    revenue: `$${(Math.random() * 50 + 1).toFixed(1)}K`,
    usage: `${Math.floor(Math.random() * 95) + 5}%`,
  };

  if (variant === "compact") {
    return (
      <m.div
        animate={{ opacity: 1, y: 0 }}
        initial={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.2 }}
        whileHover={{ scale: 1.02 }}
      >
        <Link params={{ slug: project.slug }} to="/projects/$slug">
          <Card className="group relative overflow-hidden transition-all duration-200 hover:shadow-lg cursor-pointer">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-base font-semibold leading-none">{project.name}</CardTitle>
                  <CardDescription className="text-sm">
                    {project.description ?? "No description available"}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <BadgeStatus status={project.status} />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button 
                        className="h-8 w-8 p-0 data-[state=open]:bg-muted" 
                        onClick={(e) => e.preventDefault()}
                        variant="ghost"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Open menu</span>
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
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  <span>{organizationName}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  <span>{placeholderMetrics.memberCount} member{placeholderMetrics.memberCount !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{timeAgo}</span>
                </div>
              </div>
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
      transition={{ duration: 0.2 }}
      whileHover={{ scale: 1.02 }}
    >
      <Link params={{ slug: project.slug }} to="/projects/$slug">
        <Card className="group relative overflow-hidden transition-all duration-200 hover:shadow-lg cursor-pointer">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <CardTitle className="text-lg font-semibold">{project.name}</CardTitle>
                <CardDescription className="text-sm text-muted-foreground">
                  {project.description ?? "No description available"}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <BadgeStatus status={project.status} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      className="h-8 w-8 p-0 data-[state=open]:bg-muted" 
                      onClick={(e) => e.preventDefault()}
                      variant="ghost"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Open menu</span>
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
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Endpoints</span>
                  <span className="text-sm text-muted-foreground">{placeholderMetrics.endpointCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Members</span>
                  <span className="text-sm text-muted-foreground">{placeholderMetrics.memberCount}</span>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Usage</span>
                  <span className="text-sm text-muted-foreground">{placeholderMetrics.usage}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Revenue</span>
                  <span className="text-sm text-muted-foreground">{placeholderMetrics.revenue}</span>
                </div>
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

  if (diffInSeconds < 60) return "just now";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  return `${Math.floor(diffInSeconds / 86400)}d ago`;
}
