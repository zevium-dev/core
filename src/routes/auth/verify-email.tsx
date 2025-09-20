import { arktypeResolver } from "@hookform/resolvers/arktype";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type } from "arktype";
import { useForm } from "react-hook-form";

import { CapWidget, useCapState } from "~/components/cap-widget";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth } from "~/lib/auth";
import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cn } from "~/lib/utils";

export const FormValuesArk = type({ email: "string.email" });

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/verify-email")({
  component: RouteComponent,
});

function RouteComponent() {
  const capState = useCapState();
  const navigate = useNavigate();

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues>({
    defaultValues: { email: "" },
    mode: "onBlur",
    resolver: arktypeResolver(FormValuesArk),
  });

  const requestResendEmailMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const headers = new Headers();
      if (capState.token) headers.set(CAPTCHA_HEADER_KEY, capState.token);
      return auth.sendVerificationEmail({ email: data.email }, { headers });
    },
    onSettled: () => {
      capState.reset?.();
    },
    onSuccess: () => {
      return navigate({ to: "/auth/sent-email" });
    },
  });

  const onSubmit = async (data: FormValues) => {
    await requestResendEmailMutation.mutateAsync(data);
  };

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Resend Verification Email</CardTitle>
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
                    <p
                      className={cn("text-destructive text-end text-xs", !errors.email && "invisible")}
                      id="email-error"
                    >
                      {errors.email?.message ?? "No error"}
                    </p>
                  </div>
                  <CapWidget />
                  <Button className="w-full" loading={isSubmitting} type="submit">
                    Resend
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
