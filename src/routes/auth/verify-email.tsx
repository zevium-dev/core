import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type } from "arktype";
import { useRef, useState } from "react";

import { CapWidget, type CapWidgetElement } from "~/components/cap-widget";
import { Redirect } from "~/components/redirect";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useSession } from "~/lib/auth";
import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cn, getFormErrorString } from "~/lib/utils";

export const FormValuesArk = type({ email: "string.email" });

type FormValues = typeof FormValuesArk.infer;

export const Route = createFileRoute("/auth/verify-email")({
  component: RouteComponent,
});

function RouteComponent() {
  const capRef = useRef<CapWidgetElement>(null);
  const [capToken, setCapToken] = useState<null | string>(null);
  const user = useSession().user;

  const navigate = useNavigate();

  const requestResendEmailMutation = useMutation({
    mutationFn: (data: FormValues) => {
      const headers = new Headers();
      if (capToken) headers.set(CAPTCHA_HEADER_KEY, capToken);
      return auth.sendVerificationEmail({ email: data.email }, { headers });
    },
    onSettled: () => {
      capRef.current?.reset();
    },
    onSuccess: () => {
      return navigate({ to: "/auth/sent-email" });
    },
  });

  const form = useForm({
    defaultValues: { email: "" } satisfies FormValues,
    onSubmit: ({ value }) => {
      requestResendEmailMutation.mutate(value);
    },
    validators: {
      onBlur: FormValuesArk,
      onSubmit: FormValuesArk,
    },
  });

  const isSubmitting = requestResendEmailMutation.isPending;

  if (user) {
    return <Redirect to="/" />;
  }

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Resend Verification Email</CardTitle>
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
                  <CapWidget onSolve={setCapToken} ref={capRef} />
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
