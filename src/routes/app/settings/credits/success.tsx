import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { ScreenCenter } from "~/components/ui/screen-center";
import { Spinner } from "~/components/ui/spinner";
import { waitForCreditsApplication } from "~/lib/server/credits-success";

const creditsSuccessSearchSchema = z
  .object({
    checkout_id: z.string().min(1, "checkout_id is required"),
  })
  .strict();

/* eslint-disable perfectionist/sort-objects */
export const Route = createFileRoute("/app/settings/credits/success")({
  validateSearch: creditsSuccessSearchSchema,
  beforeLoad: async ({ search }) => {
    await waitForCreditsApplication({
      data: { checkoutId: search.checkout_id },
    });

    throw redirect({ to: "/app/settings/credits" });
  },
  component: SuccessComponent,
});
/* eslint-enable perfectionist/sort-objects */

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
