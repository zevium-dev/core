import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { ScreenCenter } from "~/components/ui/screen-center";
import { Textarea } from "~/components/ui/textarea";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/create")({
  component: RouteComponent,
});

const FormZod = z.object({
  description: z.string().max(500, "Description must be less than 500 characters").optional(),
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

  // Get organization to retrieve organizationId from slug
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

  const form = useForm<FormValues>({
    defaultValues: {
      description: "",
      name: "",
      slug: "",
    },
    mode: "onBlur",
    resolver: zodResolver(FormZod),
  });

  const onSubmit = (data: FormValues) => {
    if (!orgQuery.data) {
      toast.error("Organization not found");
      return;
    }

    createProjectMutation.mutate({
      description: data.description ?? "",
      name: data.name,
      organizationId: orgQuery.data.id,
      slug: data.slug,
    });
  };

  const slugFromName = (name: string) => {
    return name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  };

  const handleNameChange = (name: string) => {
    if (!form.getValues("slug") || form.getValues("slug") === "") {
      form.setValue("slug", slugFromName(name));
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
          <Form {...form}>
            <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
              {/* Project Name */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="name">Project Name</FormLabel>
                    <FormControl>
                      <Input
                        disabled={isPending}
                        id="name"
                        placeholder="My awesome API project"
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          handleNameChange(e.target.value);
                        }}
                      />
                    </FormControl>
                    <FormDescription>The name of your project (1-100 characters)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Slug */}
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="slug">Slug</FormLabel>
                    <FormControl>
                      <Input disabled={isPending} id="slug" placeholder="my-api-project" {...field} />
                    </FormControl>
                    <FormDescription>
                      URL-friendly identifier (lowercase, hyphens only, 1-50 characters)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Description */}
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="description">Description</FormLabel>
                    <FormControl>
                      <Textarea
                        className="resize-none"
                        disabled={isPending}
                        id="description"
                        placeholder="A brief description of your project"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>A brief description of your project (max 500 characters)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Submit Button */}
              <Button className="w-full" disabled={isPending} loading={isPending} type="submit">
                Create Project
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </ScreenCenter>
  );
}
