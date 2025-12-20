import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { getRequest } from "@tanstack/react-start/server";

import { ScreenCenter } from "~/components/ui/screen-center";
import { Spinner } from "~/components/ui/spinner";
import { CreditsRedisKey } from "~/lib/server/credits";

const creditsSuccessSearchSchema = z.object({
  checkout_id: z.string().min(1, "checkout_id is required"),
}).strict();

export const Route = createFileRoute("/app/settings/credits/success")({
  validateSearch: creditsSuccessSearchSchema,
  beforeLoad: async ({ search }) => {
    // Get authenticated user from request
    const request = getRequest();
    const { authServer } = await import("~/lib/server/auth");
    const authResponse = await authServer.api.getSession({ headers: request.headers }).catch(() => null);
    
    if (!authResponse?.user?.id) {
      throw redirect({ to: "/app/settings/credits" });
    }

    const userId = authResponse.user.id;
    const checkoutId = search.checkout_id;

    // Poll on the server for credit application with timeout
    const maxWaitMs = 30_000; // 30 second timeout
    const pollIntervalMs = 500;
    const startTime = Date.now();

    const { kv } = await import("~/lib/server/kv");
    const appliedKey = CreditsRedisKey.creditApplied({ userId, checkoutId });

    // Poll until credits are applied or timeout
    while (Date.now() - startTime < maxWaitMs) {
      const applied = await kv.get<string>(appliedKey);
      if (applied) {
        // Credits have been applied, redirect to credits page
        throw redirect({ to: "/app/settings/credits" });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout reached - redirect anyway (webhook may have processed but key expired)
    throw redirect({ to: "/app/settings/credits" });
  },
  component: SuccessComponent,
});

function SuccessComponent() {
  // This component should never actually render because beforeLoad redirects
  // But keeping it as a fallback UI just in case
  return (
    <ScreenCenter>
      <div className="flex flex-col items-center gap-3">
        <Spinner />
        <div className="text-sm text-muted-foreground">Finalizing your payment…</div>
      </div>
    </ScreenCenter>
  );
}


