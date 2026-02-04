import { SiGoogle } from "@icons-pack/react-simple-icons";
import { arkTypeValidator } from "@tanstack/arktype-adapter";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type } from "arktype";
import { useEffect, useRef, useState } from "react";

import { CapWidget, type CapWidgetElement } from "~/components/cap-widget";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useSession } from "~/lib/auth";
import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cn, getFormErrorString } from "~/lib/utils";

export const FormValuesArk = type({
  email: "string.email",
  password: "0 < string < 128",
});

const SearchParamsArk = type({
  "redirectTo?": "string | undefined",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/sign-in")({
  component: RouteComponent,
  validateSearch: arkTypeValidator(SearchParamsArk),
});

function RouteComponent() {
  const queryClient = useQueryClient();
  const capRef = useRef<CapWidgetElement>(null);
  const [capToken, setCapToken] = useState<null | string>(null);

  const user = useSession().user;
  const navigate = useNavigate();
  const { redirectTo } = Route.useSearch();
  const safeRedirectTo = redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/";

  const signInMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const headers = new Headers();
      if (capToken) headers.set(CAPTCHA_HEADER_KEY, capToken);
      return auth.signIn.email({ email: data.email, password: data.password }, { headers });
    },
    onSettled: () => {
      capRef.current?.reset();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
      return navigate({ to: safeRedirectTo });
    },
  });

  const form = useForm({
    defaultValues: { email: "", password: "" } satisfies FormValues,
    onSubmit: ({ value }) => {
      signInMutation.mutate(value);
    },
    validators: {
      onBlur: FormValuesArk,
      onSubmit: FormValuesArk,
    },
  });

  const isSubmitting = signInMutation.isPending;

  const onGoogle = () => {
    void auth.signIn.social({ provider: "google" });
  };

  useEffect(() => {
    if (user) {
      void navigate({ to: safeRedirectTo });
    }
  }, [navigate, safeRedirectTo, user]);

  if (user) return null;

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Sign in</CardTitle>
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
                  <Button className="w-full" loading={isSubmitting} onClick={onGoogle} type="button" variant="outline">
                    <SiGoogle />
                    Sign in with Google
                  </Button>
                </div>
                <div
                  className={`
                  relative text-center text-sm
                  after:absolute after:inset-0 after:top-1/2 after:z-0
                  after:flex after:items-center after:border-t
                  after:border-border
                `}
                >
                  <span
                    className={`
                    relative z-10 bg-card px-2 text-muted-foreground
                  `}
                  >
                    Or continue with
                  </span>
                </div>
                <div className="grid gap-6">
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
                          <div className="flex items-center">
                            <Label className="mt-0.5" htmlFor="password">
                              Password
                            </Label>
                            <Link
                              className={`
                        ml-auto text-xs
                        hover:underline
                      `}
                              tabIndex={-1}
                              to="/auth/forgot-password"
                            >
                              Forgot your password?
                            </Link>
                          </div>
                          <Input
                            aria-describedby={isInvalid ? "password-error" : undefined}
                            aria-invalid={isInvalid}
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

                  <CapWidget onSolve={setCapToken} ref={capRef} />
                  <Button className="w-full" loading={isSubmitting} type="submit">
                    Sign in
                  </Button>
                </div>
                <div className="text-center text-sm">
                  Don&apos;t have an account?{" "}
                  <Link className="underline underline-offset-4" to="/auth/sign-up">
                    Sign up
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
