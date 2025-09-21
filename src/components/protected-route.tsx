import * as React from "react";

import { useAuthGuard } from "~/hooks/use-auth-guard";
import { useUserPreferences } from "~/hooks/use-user-preferences";

interface ProtectedRouteProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  redirectTo?: string;
}

const defaultFallback = <div>Loading...</div>;

export function ProtectedRoute({ children, fallback = defaultFallback, redirectTo = "/" }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading } = useAuthGuard(redirectTo);

  if (isLoading) {
    return <>{fallback}</>;
  }

  if (!isAuthenticated) {
    return null;
  }

  // Safe to load preferences now (user guaranteed). Only runs in authenticated areas.
  useUserPreferences();

  return <>{children}</>;
}
