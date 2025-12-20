import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ScreenCenter } from "~/components/ui/screen-center";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/settings/credits/success")({
  component: SuccessComponent,
});

function SuccessComponent() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({
    from: "/app/settings/credits/success",
  }) as { checkout_id?: string };

  const checkoutId = typeof search.checkout_id === "string" ? search.checkout_id : undefined;


  useEffect(() => {
    if (!checkoutId) {
      void navigate({ to: "/app/settings/credits" });
    }
  }, [navigate]);
  if (!checkoutId) {
    return (
      <ScreenCenter>
        <div className="flex flex-col items-center gap-3">
          <Spinner />
          <div className="text-sm text-muted-foreground">Redirecting…</div>
        </div>
      </ScreenCenter>
    );
  }

  const appliedQuery = useQuery(
    trpc.credits.awaitCreditApplied.queryOptions(
      { checkoutId },
      {
        refetchInterval: (q) => (q.state.data?.applied ? false : 1500),
      },
    ),
  );

  useEffect(() => {
    if (appliedQuery.data?.applied) {
      // Invalidate credits-related queries so the Credits page refetches fresh data
      (async () => {
        await queryClient.invalidateQueries(trpc.credits.getBalance.queryOptions());
        await queryClient.invalidateQueries(trpc.credits.listTransactions.queryOptions({ page: 1, pageSize: 3 }));
        // Go to credits page once applied
        void navigate({ to: "/app/settings/credits" });
      })();
    }
  }, [appliedQuery.data?.applied, navigate, queryClient, trpc]);

  return (
    <ScreenCenter>
      <div className="flex flex-col items-center gap-3">
        <Spinner />
        <div className="text-sm text-muted-foreground">Finalizing your payment…</div>
      </div>
    </ScreenCenter>
  );
}


