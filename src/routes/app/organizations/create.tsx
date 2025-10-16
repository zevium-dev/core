import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";

import { ImageUpload } from "~/components/image-upload";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/create")({
  component: RouteComponent,
});

const FormZod = z.object({
  logo: z.string().nullable().optional(),
  name: z.string().min(1, "Organization name is required").max(100, "Name must be less than 100 characters"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(50, "Slug must be less than 50 characters")
    .regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
});

type FormValues = z.infer<typeof FormZod>;

function RouteComponent() {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [logoData, setLogoData] = useState<null | string>(null);

  const createOrgMutation = useMutation(
    trpc.organization.create.mutationOptions({
      onSuccess: async (result) => {
        if (result) {
          toast.success("Organization created successfully");
          await Promise.all([
            queryClient.invalidateQueries(trpc.organization.list.queryOptions()),
            navigate({ to: `/app/organizations/${result.slug}` }),
          ]);
        }
      },
    }),
  );

  const form = useForm<FormValues>({
    defaultValues: {
      logo: null,
      name: "",
      slug: "",
    },
    mode: "onBlur",
    resolver: zodResolver(FormZod),
  });

  const onSubmit = async (data: FormValues) => {
    await createOrgMutation.mutateAsync({
      name: data.name,
      slug: data.slug,
      ...(data.logo && { logo: data.logo }),
    });
  };

  const handleLogoChange = (base64: string) => {
    setLogoData(base64);
    form.setValue("logo", base64);
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

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Create Organization</CardTitle>
          <CardDescription>Set up a new organization to manage your projects and team</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
              {/* Logo Upload */}
              <FormField
                control={form.control}
                name="logo"
                render={() => (
                  <FormItem>
                    <FormLabel>Logo</FormLabel>
                    <FormControl>
                      <ImageUpload
                        aspectRatio={1}
                        disabled={createOrgMutation.isPending}
                        maxSizeKb={10_000}
                        onChangeValue={handleLogoChange}
                        placeholder="Upload organization logo"
                        previewUrl={logoData ?? undefined}
                      />
                    </FormControl>
                    <FormDescription>Upload a logo for your organization (1:1 aspect ratio, max 500KB)</FormDescription>
                  </FormItem>
                )}
              />

              {/* Organization Name */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="name">Organization Name</FormLabel>
                    <FormControl>
                      <Input
                        disabled={createOrgMutation.isPending}
                        id="name"
                        placeholder="My awesome organization"
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          handleNameChange(e.target.value);
                        }}
                      />
                    </FormControl>
                    <FormDescription>The name of your organization (1-100 characters)</FormDescription>
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
                      <Input
                        disabled={createOrgMutation.isPending}
                        id="slug"
                        placeholder="my-organization"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      URL-friendly identifier (lowercase, hyphens only, 1-50 characters)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Submit Button */}
              <Button
                className="w-full"
                disabled={createOrgMutation.isPending}
                loading={createOrgMutation.isPending}
                type="submit"
              >
                Create Organization
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
