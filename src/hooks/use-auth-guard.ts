import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";

import { useUser } from "~/lib/auth";

export function useAuthGuard(redirectTo = "/") {
  const user = useUser();
  const navigate = useNavigate();

  useEffect(() => {
    // Suspense will have resolved if we're here; just redirect if no user
    if (!user) {
      toast.error("Please sign in to access this page");
      void navigate({ to: redirectTo });
    }
  }, [user, navigate, redirectTo]);

  return {
    isAuthenticated: !!user,
    // Using suspense, so loading state is handled by boundary
    isLoading: false,
    user,
  };
}
