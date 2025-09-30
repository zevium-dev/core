import { arktypeResolver } from "@hookform/resolvers/arktype";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type } from "arktype";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

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
});

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/forgot-password")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = Route.useNavigate();
  const capRef = useRef<CapWidgetElement>(null);
  const [capToken, setCapToken] = useState<null | string>(null);

  const user = useUser();

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
      const headers = new Headers();
      if (capToken) headers.set(CAPTCHA_HEADER_KEY, capToken);
      return auth.requestPasswordReset({ email: data.email }, { headers });
    },
    onSettled: () => {
      capRef.current?.reset();
    },
    onSuccess: async () => {
      await navigate({ to: "/auth/sign-in" });
      toast.success("You will receive a password reset link shortly.", { duration: 100 * 1000 });
    },
  });

  const onSubmit = async (data: FormValues) => {
    await requestPasswordResetMutation.mutateAsync(data);
  };

  if (user) {
    return <Redirect to="/" />;
  }

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
                    <p
                      className={cn("text-destructive text-end text-xs", !errors.email && "invisible")}
                      id="email-error"
                    >
                      {errors.email?.message ?? "No error"}
                    </p>
                  </div>
                  <CapWidget onSolve={setCapToken} ref={capRef} />
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
