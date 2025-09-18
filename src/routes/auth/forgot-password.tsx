import { arktypeResolver } from "@hookform/resolvers/arktype";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/forgot-password")({
  component: RouteComponent,
});

function RouteComponent() {
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { email: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

  const requestPasswordResetMutation = useMutation({
    mutationFn: (data: FormValues) => {
      return auth.requestPasswordReset({ email: data.email });
    },
  });

  const onSubmit = (data: FormValues) => {
    requestPasswordResetMutation.mutate(data);
  };

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Forgot Password</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="grid gap-6">
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
                  <CapWidget />
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
