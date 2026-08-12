import { useOrganization } from "@clerk/tanstack-react-start";
import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";

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
import { Skeleton } from "#/components/ui/skeleton";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { isPrivilegedOrgRole } from "#/lib/org-capabilities";
import { slugify } from "#/lib/slug";

export const Route = createFileRoute("/app/projects/create")({
  component: CreateProjectPage,
  head: () => ({
    meta: [{ title: "New project · Zevium" }],
  }),
});

function CreateProjectPage() {
  const navigate = useNavigate();
  const { organization, membership, isLoaded } = useOrganization();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  const createProjectFn = useConvexMutation(api.projects.create);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const slugInputRef = useRef<HTMLInputElement>(null);

  const nameError = name.trim() === "" ? "Enter a project name." : null;
  const slugError = slug.trim() === "" ? "Enter a project slug." : null;

  const { mutate, isPending } = useMutation({
    mutationFn: async (input: {
      orgSlug: string;
      name: string;
      slug: string;
      description?: string;
    }) => createProjectFn(input),
    onSuccess: (project) => {
      void navigate({
        to: "/app/projects/$projectSlug",
        params: { projectSlug: project.slug },
        replace: true,
      });
    },
    onError: (err: unknown) => {
      const message = humanError(err, "Could not create project");
      setSubmitError(message);
      if (/slug|already|exist|unique/i.test(message)) {
        slugInputRef.current?.focus();
      }
    },
  });

  function onNameChange(value: string) {
    setSubmitError(null);
    setName(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  }

  function onSlugChange(value: string) {
    setSubmitError(null);
    setSlugEdited(true);
    setSlug(slugify(value));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!orgSlug || isPending) return;
    setSubmitted(true);
    setSubmitError(null);

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (trimmedName.length === 0) {
      nameInputRef.current?.focus();
      return;
    }
    if (trimmedSlug.length === 0) {
      slugInputRef.current?.focus();
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
    return <CreateProjectSkeleton />;
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

  if (!isPrivilegedOrgRole(membership?.role)) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        <p className="text-sm text-muted-foreground">
          Organization admins create projects. Ask an admin to create this API
          or update your role.
        </p>
        <Button asChild variant="outline" className="self-start">
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
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            {submitError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {submitError}
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                ref={nameInputRef}
                id="project-name"
                name="project-name"
                autoComplete="off"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="Weather API…"
                required
                maxLength={120}
                disabled={isPending}
                aria-invalid={submitted && nameError !== null}
                aria-describedby="project-name-help"
              />
              <p
                id="project-name-help"
                className={`min-h-5 text-xs ${submitted && nameError ? "text-destructive" : "text-muted-foreground"}`}
              >
                {submitted && nameError
                  ? nameError
                  : "Shown in the dashboard and public catalogue."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-slug">Slug</Label>
              <Input
                ref={slugInputRef}
                id="project-slug"
                name="project-slug"
                autoComplete="off"
                spellCheck={false}
                value={slug}
                onChange={(e) => onSlugChange(e.target.value)}
                placeholder="weather-api…"
                required
                maxLength={64}
                disabled={isPending}
                className="font-mono text-sm"
                aria-invalid={submitted && slugError !== null}
                aria-describedby="project-slug-help"
              />
              <p
                id="project-slug-help"
                className={`min-h-5 text-xs ${submitted && slugError ? "text-destructive" : "text-muted-foreground"}`}
              >
                {submitted && slugError
                  ? slugError
                  : "Lowercase letters, numbers, and single hyphens."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-description">Description</Label>
              <Textarea
                id="project-description"
                name="project-description"
                autoComplete="off"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe inputs, outputs, and ideal use cases…"
                maxLength={2000}
                disabled={isPending}
                rows={4}
                className="min-h-24"
                aria-describedby="project-description-help"
              />
              <p
                id="project-description-help"
                className="min-h-5 text-xs text-muted-foreground"
              >
                Explain inputs, outputs, and who should use this API.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                type="button"
                disabled={isPending}
                onClick={() => void navigate({ to: "/app/projects" })}
              >
                Cancel
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

function CreateProjectSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-28 w-full" />
          <div className="flex justify-end gap-2">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
