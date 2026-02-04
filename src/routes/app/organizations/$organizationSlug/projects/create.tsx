import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import z from "zod";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { Textarea } from "~/components/ui/textarea";
import { useTRPC } from "~/lib/trpc";
import { getFormErrorString } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/create")({
  component: RouteComponent,
});

const FormZod = z.object({
  description: z.string().max(500, "Description must be less than 500 characters"),
  name: z.string().min(1, "Project name is required").max(100, "Name must be less than 100 characters"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(50, "Slug must be less than 50 characters")
    .regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
});

type FormValues = z.infer<typeof FormZod>;

function RouteComponent() {
  const navigate = useNavigate();
  const { organizationSlug } = useParams({ from: "/app/organizations/$organizationSlug/projects/create" });
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const orgQuery = useQuery(trpc.organization.get.queryOptions({ organizationSlug }));

  const createProjectMutation = useMutation(
    trpc.project.create.mutationOptions({
      onSuccess: async (result) => {
        await Promise.all([
          queryClient.invalidateQueries(trpc.project.list.queryOptions({ organizationId: result.organizationId })),
          navigate({ to: `/app/organizations/${organizationSlug}/projects/${result.slug}` }),
        ]);
      },
    }),
  );

  const form = useForm({
    defaultValues: {
      description: "",
      name: "",
      slug: "",
    } satisfies FormValues,
    onSubmit: ({ value }) => {
      if (!orgQuery.data) {
        toast.error("Organization not found");
        return;
      }

      createProjectMutation.mutate({
        description: value.description,
        name: value.name,
        organizationSlug,
        slug: value.slug,
      });
    },
    validators: {
      onBlur: FormZod,
      onSubmit: FormZod,
    },
  });

  const isSlugDirty = useStore(form.store, (state) => state.fieldMeta.slug?.isDirty ?? false);

  const slugFromName = (name: string) => {
    return name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  };

  const handleNameChange = (name: string) => {
    if (!isSlugDirty) {
      form.setFieldValue("slug", slugFromName(name));
    }
  };

  const isPending = createProjectMutation.isPending || orgQuery.isPending;

  return (
    <ScreenCenter>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Create Project</CardTitle>
          <CardDescription>Set up a new project to manage your APIs</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <form.Field
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                const error = field.state.meta.errors.at(0);

                return (
                  <div className="grid gap-2">
                    <Label htmlFor="name">Project Name</Label>
                    <Input
                      aria-describedby={isInvalid ? "name-error" : undefined}
                      aria-invalid={isInvalid}
                      disabled={isPending}
                      id="name"
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        field.handleChange(e.target.value);
                        handleNameChange(e.target.value);
                      }}
                      placeholder="My awesome API project"
                      value={field.state.value}
                    />
                    <p className="text-sm text-muted-foreground">The name of your project (1-100 characters)</p>
                    {isInvalid ? (
                      <p className="text-sm text-destructive" id="name-error">
                        {getFormErrorString(error)}
                      </p>
                    ) : null}
                  </div>
                );
              }}
              name="name"
            />

            <form.Field
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                const error = field.state.meta.errors.at(0);

                return (
                  <div className="grid gap-2">
                    <Label htmlFor="slug">Slug</Label>
                    <Input
                      aria-describedby={isInvalid ? "slug-error" : undefined}
                      aria-invalid={isInvalid}
                      disabled={isPending}
                      id="slug"
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        field.handleChange(e.target.value);
                      }}
                      placeholder="my-api-project"
                      value={field.state.value}
                    />
                    <p className="text-sm text-muted-foreground">
                      URL-friendly identifier (lowercase, hyphens only, 1-50 characters)
                    </p>
                    {isInvalid ? (
                      <p className="text-sm text-destructive" id="slug-error">
                        {getFormErrorString(error)}
                      </p>
                    ) : null}
                  </div>
                );
              }}
              name="slug"
            />

            <form.Field
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                const error = field.state.meta.errors.at(0);

                return (
                  <div className="grid gap-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      aria-describedby={isInvalid ? "description-error" : undefined}
                      aria-invalid={isInvalid}
                      className="resize-none"
                      disabled={isPending}
                      id="description"
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="A brief description of your project"
                      value={field.state.value}
                    />
                    <p className="text-sm text-muted-foreground">
                      A brief description of your project (max 500 characters)
                    </p>
                    {isInvalid ? (
                      <p className="text-sm text-destructive" id="description-error">
                        {getFormErrorString(error)}
                      </p>
                    ) : null}
                  </div>
                );
              }}
              name="description"
            />

            <Button className="w-full" disabled={isPending} loading={isPending} type="submit">
              Create Project
            </Button>
          </form>
        </CardContent>
      </Card>
    </ScreenCenter>
  );
}
