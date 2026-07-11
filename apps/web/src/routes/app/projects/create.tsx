import { useOrganization } from "@clerk/tanstack-react-start";
import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { slugify } from "#/lib/slug";

export const Route = createFileRoute("/app/projects/create")({
  component: CreateProjectPage,
  head: () => ({
    meta: [{ title: "New project · Zevium" }],
  }),
});

function CreateProjectPage() {
  const navigate = useNavigate();
  const { organization, isLoaded } = useOrganization();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  const createProjectFn = useConvexMutation(api.projects.create);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");

  const { mutate, isPending } = useMutation({
    mutationFn: async (input: {
      orgSlug: string;
      name: string;
      slug: string;
      description?: string;
    }) => createProjectFn(input),
    onSuccess: (project) => {
      toast.success("Project created");
      void navigate({
        to: "/app/projects/$projectSlug",
        params: { projectSlug: project.slug },
      });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not create project"));
    },
  });

  function onNameChange(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  }

  function onSlugChange(value: string) {
    setSlugEdited(true);
    setSlug(slugify(value));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!orgSlug || isPending) return;

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (trimmedName.length === 0 || trimmedSlug.length === 0) {
      toast.error("Name and slug are required");
      return;
    }

    mutate({
      orgSlug,
      name: trimmedName,
      slug: trimmedSlug,
      description: description.trim() === "" ? undefined : description.trim(),
    });
  }

  if (!isLoaded) {
    return null;
  }

  if (!orgSlug) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
          <p className="text-sm text-muted-foreground">
            Select an organization first.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/app/projects">Back to projects</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        <p className="text-sm text-muted-foreground">
          Name it, then paste an OpenAPI spec on the next screen.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Project details</CardTitle>
          <CardDescription>
            Slug is unique within your organization and used in gateway URLs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="Weather API"
                autoFocus
                required
                maxLength={120}
                disabled={isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-slug">Slug</Label>
              <Input
                id="project-slug"
                value={slug}
                onChange={(e) => onSlugChange(e.target.value)}
                placeholder="weather-api"
                required
                maxLength={64}
                disabled={isPending}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, hyphens.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-description">Description</Label>
              <textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this API do?"
                maxLength={2000}
                disabled={isPending}
                rows={4}
                className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                asChild
                variant="ghost"
                type="button"
                disabled={isPending}
              >
                <Link to="/app/projects">Cancel</Link>
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
