// This file contains types that are needed by route files.
// It's separate from router.tsx to avoid circular dependencies during Vite SSR HMR.
import type { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import type { AppRouter } from "~/server";

export type TrpcOptionsProxy = ReturnType<typeof createTRPCOptionsProxy<AppRouter>>;
