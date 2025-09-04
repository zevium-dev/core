import { 
  Building2, 
  Clock, 
  Code, 
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
import { mockProjects } from "~/lib/utils/mockdata";

interface ProjectCardProps {
  project: typeof mockProjects[0];
  variant?: "compact" | "default";
}

export function ProjectCard({ project, variant = "default" }: ProjectCardProps) {
  if (variant === "compact") {
    return (
      <m.div
        animate={{ opacity: 1, y: 0 }}
        initial={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.2 }}
        whileHover={{ y: -4 }}
      >
        <Card className="h-full transition-shadow duration-200 hover:shadow-lg">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <h3 className="text-lg leading-tight font-semibold">{project.name}</h3>
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Building2 className="h-3 w-3" />
                  {project.organization}
                </p>
              </div>
              <BadgeStatus status={project.status}>{project.status}</BadgeStatus>
            </div>
          </CardHeader>

          <CardContent className="pb-4">
            <p className="text-muted-foreground mb-4 line-clamp-2 text-sm">{project.description}</p>

            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="space-y-1">
                <div className="flex items-center justify-center gap-1 text-lg font-semibold">
                  <Code className="h-4 w-4 text-blue-500" />
                  {project.apis.length}
                </div>
                <p className="text-muted-foreground text-xs">APIs</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-center gap-1 text-lg font-semibold">
                  <Users className="h-4 w-4 text-green-500" />
                  {project.members}
                </div>
                <p className="text-muted-foreground text-xs">Members</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-center gap-1 text-lg font-semibold">
                  <span className="text-purple-500">$</span>
                  {project.pricing.pro}
                </div>
                <p className="text-muted-foreground text-xs">Pro Plan</p>
              </div>
            </div>
          </CardContent>

          <div className="border-t pt-4 px-6 pb-6">
            <div className="flex w-full items-center justify-between">
              <span className="text-muted-foreground text-xs">Updated {project.lastUpdated}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4" />
                    Manage
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Documentation
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Users className="mr-2 h-4 w-4" />
                    Permissions
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </Card>
      </m.div>
    );
  }

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      initial={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.5 }}
      whileHover={{ transition: { duration: 0.2 }, y: -4 }}
    >
      <Card className="group hover:shadow-lg transition-all duration-300 border-border/50 hover:border-border">
        <CardHeader className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg font-semibold group-hover:text-primary transition-colors">
                  {project.name}
                </CardTitle>
                <BadgeStatus status={project.status}>
                  {project.status}
                </BadgeStatus>
              </div>
              <CardDescription className="text-sm text-muted-foreground line-clamp-2">
                {project.description}
              </CardDescription>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="h-8 w-8 p-0" size="sm" variant="ghost">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View Documentation
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Users className="h-4 w-4 mr-2" />
                  Manage Team
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              <span>{project.organization}</span>
            </div>
            <div className="flex items-center gap-1">
              <Code className="h-3 w-3" />
              <span>{project.version}</span>
            </div>
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>{project.lastUpdated}</span>
            </div>
          </div>
        </CardHeader>
        
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">API Usage</span>
                <span className="font-medium">{project.usage}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-1.5">
                <m.div 
                  animate={{ width: `${project.usage}%` }}
                  className="bg-gradient-to-r from-green-500 to-emerald-500 h-1.5 rounded-full"
                  initial={{ width: 0 }}
                  transition={{ delay: 0.5, duration: 1 }}
                />
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm text-muted-foreground">Monthly Revenue</div>
              <div className="text-lg font-semibold text-green-600">{project.revenue}</div>
            </div>
          </div>
          
          <div className="flex items-center justify-between pt-2 border-t border-border/50">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>{project.endpoints} endpoints</span>
              <span>{project.members} members</span>
            </div>
            <Button className="group-hover:bg-primary group-hover:text-primary-foreground transition-colors" size="sm" variant="outline">
              View Details
            </Button>
          </div>
        </CardContent>
      </Card>
    </m.div>
  );
}
