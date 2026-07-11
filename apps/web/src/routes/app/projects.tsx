import { createFileRoute } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";

export const Route = createFileRoute("/app/projects")({
  component: ProjectsPage,
  head: () => ({
    meta: [{ title: "Projects · Zevium" }],
  }),
});

function ProjectsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Publish APIs from OpenAPI specs.
          </p>
        </div>
        <Button disabled>New project</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:-translate-y-0.5 hover:shadow-sm">
            <CardHeader>
              <Skeleton className="mb-2 h-5 w-1/2" />
              <CardTitle className="sr-only">Project placeholder</CardTitle>
              <CardDescription>
                <Skeleton className="h-4 w-3/4" />
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
