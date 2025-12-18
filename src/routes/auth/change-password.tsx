import { arktypeResolver } from "@hookform/resolvers/arktype";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { type } from "arktype";
import { useForm } from "react-hook-form";

import { Redirect } from "~/components/redirect";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useSession } from "~/lib/auth";
import { cn } from "~/lib/utils";

export const FormValuesArk = type({
  currentPassword: "0 < string < 128",
  password: "0 < string < 128",
  passwordConfirm: "0 < string < 128",
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/change-password")({
  component: RouteComponent,
});

function RouteComponent() {
  const user = useSession().user;

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { password: "", passwordConfirm: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const password = data.password;
      const passwordConfirm = data.passwordConfirm;
      if (password !== passwordConfirm) throw new TRPCClientError("Passwords do not match");
      return auth.changePassword({ currentPassword: data.currentPassword, newPassword: password });
    },
    onSuccess: () => {
      return auth.signOut();
    },
  });

  const onSubmit = (data: FormValues) => {
    resetPasswordMutation.mutate(data);
  };

  if (!user) {
    return <Redirect to="/" />;
  }

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Change password</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="grid gap-6">
                <div className="grid gap-6">
                  <div className="grid gap-3">
                    <Label htmlFor="current-password">Current password</Label>
                    <Input
                      aria-describedby={errors.currentPassword ? "current-password-error" : undefined}
                      aria-invalid={!!errors.currentPassword}
                      disabled={isSubmitting}
                      id="current-password"
                      type="password"
                      {...register("currentPassword")}
                    />
                    <p
                      className={cn(
                        "text-end text-xs text-destructive",
                        !errors.currentPassword &&
                          `
                        invisible
                      `,
                      )}
                      id="current-password-error"
                    >
                      {errors.currentPassword?.message ?? "No error"}
                    </p>
                  </div>
                  <div className="grid gap-3">
                    <Label htmlFor="password">New password</Label>
                    <Input
                      aria-describedby={errors.password ? "password-error" : undefined}
                      aria-invalid={!!errors.password}
                      disabled={isSubmitting}
                      id="password"
                      type="password"
                      {...register("password")}
                    />
                    <p
                      className={cn(
                        "text-end text-xs text-destructive",
                        !errors.password &&
                          `
                        invisible
                      `,
                      )}
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
                      className={cn(
                        "text-end text-xs text-destructive",
                        !errors.passwordConfirm &&
                          `
                        invisible
                      `,
                      )}
                      id="password-confirm-error"
                    >
                      {errors.passwordConfirm?.message ?? "No error"}
                    </p>
                  </div>
                  <Button className="w-full" loading={isSubmitting} type="submit">
                    Change password
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </ScreenCenter>
  );
}
