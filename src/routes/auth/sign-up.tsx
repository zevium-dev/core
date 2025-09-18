import { arktypeResolver } from "@hookform/resolvers/arktype";
import { SiGoogle } from "@icons-pack/react-simple-icons";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { type } from "arktype";
import { useForm } from "react-hook-form";

import { CapWidget } from "~/components/cap-widget";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth } from "~/lib/auth";
import { cn } from "~/lib/utils";

export const FormValuesArk = type({
  email: "string.email",
  "name?": "0 < string < 128",
  password: "0 < string < 128",
  "password-confirm": "0 < string < 128",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/sign-up")({
  component: RouteComponent,
});

function RouteComponent() {
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { email: "", name: "", password: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

  const signUpMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const email = data.email.trim();
      const name = data.name?.trim() ?? email.split("@").at(0) ?? crypto.randomUUID();
      const password = data.password;
      const passwordConfirm = data["password-confirm"];
      if (password !== passwordConfirm) throw new TRPCClientError("Passwords do not match");
      return auth.signUp.email({ email, name, password });
    },
  });

  const onSubmit = (data: FormValues) => {
    signUpMutation.mutate(data);
  };

  const onGoogle = () => {
    void auth.signIn.social({ provider: "google" });
  };

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
                    {errors.email && (
                      <p className="text-destructive text-sm" id="email-error">
                        {errors.email.message}
                      </p>
                    )}
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
                    {errors.password && (
                      <p className="text-destructive text-sm" id="password-error">
                        {errors.password.message}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-3">
                    <Label htmlFor="password-confirm">Confirm password</Label>
                    <Input
                      aria-describedby={errors["password-confirm"] ? "password-confirm-error" : undefined}
                      aria-invalid={!!errors["password-confirm"]}
                      disabled={isSubmitting}
                      id="password-confirm"
                      type="password"
                      {...register("password-confirm")}
                    />
                    {errors["password-confirm"] && (
                      <p className="text-destructive text-sm" id="password-confirm-error">
                        {errors["password-confirm"].message}
                      </p>
                    )}
                  </div>
                  <CapWidget />
                  <Button className="w-full" loading={isSubmitting} type="submit">
                    Sign up
                  </Button>
                </div>
                <div className="text-center text-sm">
                  Already have an account?{" "}
                  <Link className="underline underline-offset-4" to="/auth">
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
