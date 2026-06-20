import { SiGoogle } from "@icons-pack/react-simple-icons";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { type } from "arktype";

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
  email: "string.email < 256",
  "name?": "0 < string < 128",
  password: "0 < string < 128",
  passwordConfirm: "0 < string < 128",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/sign-up")({
  component: RouteComponent,
});

function RouteComponent() {
  const user = useSession().user;
  const navigate = useNavigate();

  const signUpMutation = useMutation({
    mutationFn: ({ data, token }: { data: FormValues; token: string }) => {
      const email = data.email.trim();
      const name = data.name?.trim() ?? email.split("@").at(0) ?? crypto.randomUUID();
      const password = data.password;
      const passwordConfirm = data.passwordConfirm;
      if (password !== passwordConfirm) throw new TRPCClientError("Passwords do not match");
      const headers = new Headers();
      headers.set(CAPTCHA_HEADER_KEY, token);
      return auth.signUp.email({ email, name, password }, { headers });
    },
    onSuccess: () => {
      return navigate({ to: "/auth/sent-email" });
    },
  });

  const form = useForm({
    defaultValues: { email: "", name: "", password: "", passwordConfirm: "" } satisfies FormValues,
    onSubmit: async ({ value }) => {
      const token = await solveCap();
      signUpMutation.mutate({ data: value, token });
    },
    validators: {
      onBlur: FormValuesArk,
      onSubmit: FormValuesArk,
    },
  });

  const isSubmitting = signUpMutation.isPending;

  const onGoogle = () => {
    void auth.signIn.social({ provider: "google" });
  };

  if (user) {
    return <Redirect to="/" />;
  }

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Sign up</CardTitle>
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
                <div className="flex flex-col gap-4">
                  <Button className="w-full" disabled={isSubmitting} onClick={onGoogle} type="button" variant="outline">
                    <SiGoogle />
                    Sign up with Google
                  </Button>
                </div>
                <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                  <span className="relative z-10 bg-card px-2 text-muted-foreground">Or continue with</span>
                </div>
                <AuthFormClientOnly
                  fields={[
                    { labelWidthClass: "w-12" },
                    { labelWidthClass: "w-12" },
                    { labelWidthClass: "w-16" },
                    { labelWidthClass: "w-28" },
                  ]}
                >
                  <div className="grid gap-6">
                    <form.Field
                      children={(field) => {
                        const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                        const error = field.state.meta.errors.at(0);

                        return (
                          <div className="grid gap-3">
                            <Label htmlFor="name">Name</Label>
                            <Input
                              aria-describedby={isInvalid ? "name-error" : undefined}
                              aria-invalid={isInvalid}
                              autoComplete="name"
                              disabled={isSubmitting}
                              id="name"
                              name={field.name}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder="Your Name"
                              type="text"
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
                              id="name-error"
                            >
                              {isInvalid ? getFormErrorString(error) : "No error"}
                            </p>
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
                              className={cn(
                                "text-end text-xs text-destructive",
                                !isInvalid &&
                                  `
                        invisible
                      `,
                              )}
                              id="email-error"
                            >
                              {isInvalid ? getFormErrorString(error) : "No error"}
                            </p>
                          </div>
                        );
                      }}
                      name="email"
                    />

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
                      Sign up
                    </Button>
                  </div>
                </AuthFormClientOnly>
                <div className="text-center text-sm">
                  Already have an account?{" "}
                  <Link className="underline underline-offset-4" to="/auth/sign-in">
                    Sign in
                  </Link>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </ScreenCenter>
  );
}
