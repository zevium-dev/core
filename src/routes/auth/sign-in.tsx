import { arktypeResolver } from "@hookform/resolvers/arktype";
import { SiGoogle } from "@icons-pack/react-simple-icons";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type } from "arktype";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { CapWidget, type CapWidgetElement } from "~/components/cap-widget";
import { Redirect } from "~/components/redirect";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useUser } from "~/lib/auth";
import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cn } from "~/lib/utils";

export const FormValuesArk = type({
  email: "string.email",
  password: "0 < string < 128",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/sign-in")({
  component: RouteComponent,
});

function RouteComponent() {
  const capRef = useRef<CapWidgetElement>(null);
  const [capToken, setCapToken] = useState<null | string>(null);

  const user = useUser();
  const navigate = Route.useNavigate();

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { email: "", password: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

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
      return navigate({ to: "/" });
    },
  });

  const onSubmit = async (data: FormValues) => {
    await signInMutation.mutateAsync(data);
  };

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
            <CardTitle className="text-xl">Sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="grid gap-6">
                <div className="flex flex-col gap-4">
                  <Button className="w-full" disabled={isSubmitting} onClick={onGoogle} type="button" variant="outline">
                    <SiGoogle />
                    Sign in with Google
                  </Button>
                </div>
                <div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
                  <span className="bg-card text-muted-foreground relative z-10 px-2">Or continue with</span>
                </div>
                <div className="grid gap-6">
                  <div className="grid gap-3">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      aria-describedby={errors.email ? "email-error" : undefined}
                      aria-invalid={!!errors.email}
                      disabled={isSubmitting}
                      id="email"
                      placeholder="me@example.com"
                      type="email"
                      {...register("email")}
                    />
                    <p
                      className={cn("text-destructive text-end text-xs", !errors.email && "invisible")}
                      id="email-error"
                    >
                      {errors.email?.message ?? "No error"}
                    </p>
                  </div>
                  <div className="grid gap-3">
                    <div className="flex items-center">
                      <Label className="mt-0.5" htmlFor="password">
                        Password
                      </Label>
                      <Link className="ml-auto text-xs hover:underline" tabIndex={-1} to="/auth/forgot-password">
                        Forgot your password?
                      </Link>
                    </div>
                    <Input
                      aria-describedby={errors.password ? "password-error" : undefined}
                      aria-invalid={!!errors.password}
                      disabled={isSubmitting}
                      id="password"
                      type="password"
                      {...register("password")}
                    />
                    <p
                      className={cn("text-destructive text-end text-xs", !errors.password && "invisible")}
                      id="password-error"
                    >
                      {errors.password?.message ?? "No error"}
                    </p>
                  </div>
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
