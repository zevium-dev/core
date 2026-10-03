import type { QueryClient } from "@tanstack/react-query";

export type PrincipalSnapshot = {
  userId: string | null;
  orgId: string | null;
};

export interface PrincipalCache {
  readonly currentKey: string;
  readonly snapshot: PrincipalSnapshot;
  keyFor(userId: string | null, orgId: string | null): string;
  transition(userId: string | null, orgId: string | null): Promise<void>;
}

export function createPrincipalCache(
  getQueryClient: () => QueryClient,
): PrincipalCache {
  let snapshot: PrincipalSnapshot = { userId: null, orgId: null };
  const keyFor = (userId: string | null, orgId: string | null) =>
    `${userId ?? "anonymous"}:${orgId ?? "-"}`;

  return {
    get currentKey() {
      return keyFor(snapshot.userId, snapshot.orgId);
    },
    get snapshot() {
      return { ...snapshot };
    },
    keyFor,
    async transition(userId, orgId) {
      if (keyFor(userId, orgId) === this.currentKey) return;
      const queryClient = getQueryClient();
      await queryClient.cancelQueries();
      queryClient.removeQueries();
      queryClient.getMutationCache().clear();
      snapshot = { userId, orgId };
    },
  };
}
