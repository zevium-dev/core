import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { auth } from "~/lib/auth";
import { useTRPCClient } from "~/lib/trpc";

// We scope strictly by userId so cache is isolated. No generic base entry.
// Query key shape: ["user-preferences", userId]
const KEY_PREFIX = "user-preferences" as const;

export function useUserPreferences() {
  const session = auth.useSession();
  const trpc = useTRPCClient();
  const qc = useQueryClient();
  const userId = session.data?.user?.id;

  const queryKey = [KEY_PREFIX, userId] as const;
  const hadUserRef = useRef<boolean>(false);

  const query = useQuery({
    queryKey,
    enabled: Boolean(userId),
    queryFn: async () => {
      const result = await trpc.userPreference.get.query();
      return result; // { timezone }
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (input: { timezone?: string }) => {
      return await trpc.userPreference.update.mutate(input);
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data);
    },
  });

  // On transition from no user -> user, trigger an immediate refetch (cold start)
  useEffect(() => {
    if (userId && !hadUserRef.current) {
      hadUserRef.current = true;
      void query.refetch();
    }
    if (!userId && hadUserRef.current) {
      hadUserRef.current = false;
      qc.removeQueries({ queryKey: [KEY_PREFIX] });
    }
  }, [userId, qc, query]);

  return {
    preferences: query.data,
    isLoading: query.isLoading,
    error: query.error,
    update: mutation.mutateAsync,
    isUpdating: mutation.isPending,
    refetch: query.refetch,
  };
}
