import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { ImageUpload } from "~/components/image-upload";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useTRPC } from "~/lib/trpc";
import { getFormErrorString } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/create")({
  component: RouteComponent,
});

const FormZod = z.object({
  logo: z.string().nullable(),
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
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

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

  const form = useForm({
    defaultValues: {
      logo: null,
      name: "",
      slug: "",
    } as FormValues,
    onSubmit: ({ value }) => {
      createOrgMutation.mutate({
        name: value.name,
        slug: value.slug,
        ...(value.logo ? { logo: value.logo } : {}),
      });
    },
    validators: {
      onBlur: FormZod,
      onSubmit: FormZod,
    },
  });

  const handleLogoChange = (base64: string) => {
    setLogoData(base64);
    form.setFieldValue("logo", base64);
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
    if (!slugManuallyEdited) {
      form.setFieldValue("slug", slugFromName(name));
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
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <form.Field
              children={() => (
                <div className="grid gap-2">
                  <Label>Logo</Label>
                  <ImageUpload
                    aspectRatio={1}
                    disabled={createOrgMutation.isPending}
                    maxSizeKb={10_000}
                    onChangeValue={handleLogoChange}
                    placeholder="Upload organization logo"
                    previewUrl={logoData ?? undefined}
                  />
                  <p className="text-sm text-muted-foreground">
                    Upload a logo for your organization (1:1 aspect ratio, max 10MB)
                  </p>
                </div>
              )}
              name="logo"
            />

            <form.Field
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                const error = field.state.meta.errors.at(0);

                return (
                  <div className="grid gap-2">
                    <Label htmlFor="name">Organization Name</Label>
                    <Input
                      aria-describedby={isInvalid ? "name-error" : undefined}
                      aria-invalid={isInvalid}
                      disabled={createOrgMutation.isPending}
                      id="name"
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        field.handleChange(e.target.value);
                        handleNameChange(e.target.value);
                      }}
                      placeholder="My awesome organization"
                      value={field.state.value}
                    />
                    <p className="text-sm text-muted-foreground">The name of your organization (1-100 characters)</p>
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
                      disabled={createOrgMutation.isPending}
                      id="slug"
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        setSlugManuallyEdited(true);
                        field.handleChange(e.target.value);
                      }}
                      placeholder="my-organization"
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

            <Button
              className="w-full"
              disabled={createOrgMutation.isPending}
              loading={createOrgMutation.isPending}
              type="submit"
            >
              Create Organization
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
