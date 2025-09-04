import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";

import { auth } from "~/lib/auth";

export function useAuthGuard(redirectTo = "/") {
  const authState = auth.useSession();
  const navigate = useNavigate();

  useEffect(() => {
    // Only check auth after loading is complete
    if (!authState.isPending && !authState.data?.user) {
      toast.error("Please sign in to access this page");
      void navigate({ to: redirectTo });
    }
  }, [authState.isPending, authState.data?.user, navigate, redirectTo]);

  return {
    isAuthenticated: !!authState.data?.user,
    isLoading: authState.isPending,
    user: authState.data?.user,
  };
}
