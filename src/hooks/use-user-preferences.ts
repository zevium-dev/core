import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { auth } from "~/lib/auth";
import { useTRPCClient } from "~/lib/trpc";

// Base key; we append userId for per-user scoping so multiple users in the
// same session context (e.g. impersonation, test harness) don't share cache.
const BASE_KEY = ["user-preferences"] as const;

export function useUserPreferences() {
  const session = auth.useSession();
  const trpc = useTRPCClient();
  const qc = useQueryClient();
  const userId = session.data?.user?.id;

  const enabled = Boolean(userId);
  const queryKey = userId ? ([...BASE_KEY, userId] as const) : BASE_KEY;

  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      const result = await trpc.userPreference.get.query();
      return result; // { timezone }
    },
    staleTime: 5 * 60 * 1000, // 5 min; low churn
  });

  const mutation = useMutation({
    mutationFn: async (input: { timezone?: string }) => {
      return await trpc.userPreference.update.mutate(input);
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data);
    },
  });

  // Cleanup: when user logs out remove all user-preferences queries so
  // previous user's data does not linger in cache.
  useEffect(() => {
    if (!userId) {
      qc.removeQueries({ queryKey: BASE_KEY });
    }
  }, [userId, qc]);

  return {
    preferences: query.data,
    isLoading: query.isLoading,
    error: query.error,
    update: mutation.mutateAsync,
    isUpdating: mutation.isPending,
  };
}
