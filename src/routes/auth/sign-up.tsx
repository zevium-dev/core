import { arktypeResolver } from "@hookform/resolvers/arktype";
import { SiGoogle } from "@icons-pack/react-simple-icons";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
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
import { auth } from "~/lib/auth";
import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cn } from "~/lib/utils";

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
  const capRef = useRef<CapWidgetElement>(null);
  const [capToken, setCapToken] = useState<null | string>(null);

  const authState = auth.useSession();
  const navigate = useNavigate();

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { email: "", name: "", password: "", passwordConfirm: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

  const signUpMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const email = data.email.trim();
      const name = data.name?.trim() ?? email.split("@").at(0) ?? crypto.randomUUID();
      const password = data.password;
      const passwordConfirm = data.passwordConfirm;
      if (password !== passwordConfirm) throw new TRPCClientError("Passwords do not match");
      const headers = new Headers();
      if (capToken) headers.set(CAPTCHA_HEADER_KEY, capToken);
      return auth.signUp.email({ email, name, password }, { headers });
    },
    onSettled: () => {
      capRef.current?.reset();
    },
    onSuccess: () => {
      return navigate({ to: "/auth/sent-email" });
    },
  });

  const onSubmit = async (data: FormValues) => {
    await signUpMutation.mutateAsync(data);
  };

  const onGoogle = () => {
    void auth.signIn.social({ provider: "google" });
  };

  if (authState.data?.user) {
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
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="grid gap-6">
                <div className="flex flex-col gap-4">
                  <Button className="w-full" disabled={isSubmitting} onClick={onGoogle} type="button" variant="outline">
                    <SiGoogle />
                    Sign up with Google
                  </Button>
                </div>
                <div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
                  <span className="bg-card text-muted-foreground relative z-10 px-2">Or continue with</span>
                </div>
                <div className="grid gap-6">
                  <div className="grid gap-3">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      aria-describedby={errors.name ? "name-error" : undefined}
                      aria-invalid={!!errors.name}
                      disabled={isSubmitting}
                      id="name"
                      placeholder="Your Name"
                      type="text"
                      {...register("name")}
                    />
                    <p className={cn("text-destructive text-end text-xs", !errors.name && "invisible")} id="name-error">
                      {errors.name?.message ?? "No error"}
                    </p>
                  </div>
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
                    <Label htmlFor="password">Password</Label>
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
                  <div className="grid gap-3">
                    <Label htmlFor="password-confirm">Confirm password</Label>
                    <Input
                      aria-describedby={errors.passwordConfirm ? "password-confirm-error" : undefined}
                      aria-invalid={!!errors.passwordConfirm}
                      disabled={isSubmitting}
                      id="password-confirm"
                      type="password"
                      {...register("passwordConfirm")}
                    />
                    <p
                      className={cn("text-destructive text-end text-xs", !errors.passwordConfirm && "invisible")}
                      id="password-confirm-error"
                    >
                      {errors.passwordConfirm?.message ?? "No error"}
                    </p>
                  </div>
                  <CapWidget onSolve={setCapToken} ref={capRef} />
                  <Button className="w-full" loading={isSubmitting} type="submit">
                    Sign up
                  </Button>
                </div>
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
