import { arktypeResolver } from "@hookform/resolvers/arktype";
import { arkTypeValidator } from "@tanstack/arktype-adapter";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { type } from "arktype";
import { useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth } from "~/lib/auth";
import { cn } from "~/lib/utils";

const SearchParamsArk = type({
  token: "0 < string < 256",
});

export const FormValuesArk = type({
  password: "0 < string < 128",
  "password-confirm": "0 < string < 128",
}).and(SearchParamsArk);

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/reset-password")({
  component: RouteComponent,
  validateSearch: arkTypeValidator(SearchParamsArk),
});

function RouteComponent() {
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { password: "", "password-confirm": "", token: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const token = data.token;
      const password = data.password;
      const passwordConfirm = data["password-confirm"];
      if (password !== passwordConfirm) throw new TRPCClientError("Passwords do not match");
      return auth.resetPassword({ newPassword: password, token });
    },
  });

  const onSubmit = async (data: FormValues) => {
    await resetPasswordMutation.mutateAsync(data);
  };

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Reset password</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="grid gap-6">
                <div className="grid gap-6">
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
                      aria-describedby={errors["password-confirm"] ? "password-confirm-error" : undefined}
                      aria-invalid={!!errors["password-confirm"]}
                      disabled={isSubmitting}
                      id="password-confirm"
                      type="password"
                      {...register("password-confirm")}
                    />
                    <p
                      className={cn("text-destructive text-end text-xs", !errors["password-confirm"] && "invisible")}
                      id="password-confirm-error"
                    >
                      {errors["password-confirm"]?.message ?? "No error"}
                    </p>
                  </div>
                  <div className="hidden gap-3">
                    <Label htmlFor="token">Token</Label>
                    <Input
                      aria-describedby={errors.token ? "token-error" : undefined}
                      aria-invalid={!!errors.token}
                      disabled={isSubmitting}
                      id="token"
                      type="password"
                      {...register("token")}
                    />
                    <p
                      className={cn("text-destructive text-end text-xs", !errors.token && "invisible")}
                      id="token-error"
                    >
                      {errors.token?.message ?? "No error"}
                    </p>
                  </div>
                  <Button className="w-full" loading={isSubmitting} type="submit">
                    Reset password
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
