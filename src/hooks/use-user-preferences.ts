import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "~/lib/auth";
import { useTRPC } from "~/lib/trpc";

export const useUserPreferencesMutation = () => {
  const trpc = useTRPC();
  const qc = useQueryClient();

  return useMutation(
    trpc.userPreference.update.mutationOptions({
      onMutate(variables) {
        qc.setQueryData(trpc.userPreference.get.queryKey(), (old) => ({ ...old, ...variables }));
      },
      async onSettled() {
        await qc.invalidateQueries(trpc.userPreference.get.queryOptions());
      },
    }),
  );
};

export const useUserPreferencesQuery = () => {
  const user = useSession().user;
  const trpc = useTRPC();

  return useQuery(trpc.userPreference.get.queryOptions(undefined, { enabled: !!user?.id }));
};
