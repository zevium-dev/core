import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type } from "arktype";
import { toast } from "sonner";

import { AuthFormClientOnly } from "~/components/auth-form-client-only";
import { Redirect } from "~/components/redirect";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useSession } from "~/lib/auth";
import { solveCap } from "~/lib/client/cap";
import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cn, getFormErrorString } from "~/lib/utils";

export const FormValuesArk = type({
  email: "string.email",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/forgot-password")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = Route.useNavigate();

  const user = useSession().user;

  const requestPasswordResetMutation = useMutation({
    mutationFn: async (data: FormValues) => {
      const token = await solveCap();
      const headers = new Headers();
      headers.set(CAPTCHA_HEADER_KEY, token);
      return auth.requestPasswordReset({ email: data.email }, { headers });
    },
    onSuccess: async () => {
      await navigate({ to: "/auth/sign-in" });
      toast.success("You will receive a password reset link shortly.", { duration: 100 * 1000 });
    },
  });

  const form = useForm({
    defaultValues: { email: "" } satisfies FormValues,
    onSubmit: ({ value }) => {
      requestPasswordResetMutation.mutate(value);
    },
    validators: {
      onBlur: FormValuesArk,
      onSubmit: FormValuesArk,
    },
  });

  const isSubmitting = requestPasswordResetMutation.isPending;

  if (user) {
    return <Redirect to="/" />;
  }

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Forgot Password</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <div className="grid gap-6">
                <AuthFormClientOnly fields={[{ labelWidthClass: "w-12" }]}>
                  <div className="grid gap-6">
                    <form.Field
                      children={(field) => {
                        const isInvalid =
                          (field.state.meta.isBlurred || field.form.state.isSubmitted) &&
                          field.state.meta.errors.length > 0;
                        const error = field.state.meta.errors.at(0);

                        return (
                          <div className="grid gap-3">
                            <Label htmlFor="email">Email</Label>
                            <Input
                              aria-describedby={isInvalid ? "email-error" : undefined}
                              aria-invalid={isInvalid}
                              autoComplete="email"
                              disabled={isSubmitting}
                              id="email"
                              name={field.name}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder="me@example.com"
                              type="email"
                              value={field.state.value}
                            />
                            <p
                              className={cn("text-end text-xs text-destructive", !isInvalid && "invisible")}
                              id="email-error"
                            >
                              {isInvalid ? getFormErrorString(error) : "No error"}
                            </p>
                          </div>
                        );
                      }}
                      name="email"
                    />
                    <Button className="w-full" loading={isSubmitting} type="submit">
                      Reset password
                    </Button>
                  </div>
                </AuthFormClientOnly>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </ScreenCenter>
  );
}
