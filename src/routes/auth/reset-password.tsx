import { arkTypeValidator } from "@tanstack/arktype-adapter";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
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
import { cn, getFormErrorString } from "~/lib/utils";

const SearchParamsArk = type({
  token: "0 < string < 256",
});

export const FormValuesArk = type({
  password: "0 < string < 128",
  passwordConfirm: "0 < string < 128",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/reset-password")({
  component: RouteComponent,
  validateSearch: arkTypeValidator(SearchParamsArk),
});

function RouteComponent() {
  const navigate = Route.useNavigate();
  const { token } = Route.useSearch();

  const user = useSession().user;

  const resetPasswordMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const password = data.password;
      const passwordConfirm = data.passwordConfirm;
      if (password !== passwordConfirm) throw new TRPCClientError("Passwords do not match");
      return auth.resetPassword({ newPassword: password, token });
    },
    onSuccess: async () => {
      await navigate({ to: "/auth/sign-in" });
      toast.success("Reset successful. Please sign in.", { duration: 100 * 1000 });
    },
  });

  const form = useForm({
    defaultValues: { password: "", passwordConfirm: "" } satisfies FormValues,
    onSubmit: ({ value }) => {
      resetPasswordMutation.mutate(value);
    },
    validators: {
      onBlur: FormValuesArk,
      onSubmit: FormValuesArk,
    },
  });

  const isSubmitting = resetPasswordMutation.isPending;

  if (user) {
    return <Redirect to="/" />;
  }

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Reset password</CardTitle>
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
                <AuthFormClientOnly fields={[{ labelWidthClass: "w-16" }, { labelWidthClass: "w-28" }]}>
                  <div className="grid gap-6">
                    <form.Field
                      children={(field) => {
                        const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                        const error = field.state.meta.errors.at(0);

                        return (
                          <div className="grid gap-3">
                            <Label htmlFor="password">Password</Label>
                            <Input
                              aria-describedby={isInvalid ? "password-error" : undefined}
                              aria-invalid={isInvalid}
                              autoComplete="new-password"
                              disabled={isSubmitting}
                              id="password"
                              name={field.name}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              type="password"
                              value={field.state.value}
                            />
                            <p
                              className={cn(
                                "text-end text-xs text-destructive",
                                !isInvalid &&
                                  `
                        invisible
                      `,
                              )}
                              id="password-error"
                            >
                              {isInvalid ? getFormErrorString(error) : "No error"}
                            </p>
                          </div>
                        );
                      }}
                      name="password"
                    />

                    <form.Field
                      children={(field) => {
                        const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                        const error = field.state.meta.errors.at(0);

                        return (
                          <div className="grid gap-3">
                            <Label htmlFor="password-confirm">Confirm password</Label>
                            <Input
                              aria-describedby={isInvalid ? "password-confirm-error" : undefined}
                              aria-invalid={isInvalid}
                              autoComplete="new-password"
                              disabled={isSubmitting}
                              id="password-confirm"
                              name={field.name}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              type="password"
                              value={field.state.value}
                            />
                            <p
                              className={cn(
                                "text-end text-xs text-destructive",
                                !isInvalid &&
                                  `
                        invisible
                      `,
                              )}
                              id="password-confirm-error"
                            >
                              {isInvalid ? getFormErrorString(error) : "No error"}
                            </p>
                          </div>
                        );
                      }}
                      name="passwordConfirm"
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
