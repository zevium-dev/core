import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { CreditsRedisKey } from "~/lib/shared/credits-keys";

const WaitForCreditsApplicationInputZod = z.object({
  checkoutId: z.string().min(1, "checkoutId is required"),
});

export const waitForCreditsApplication = createServerFn({ method: "GET" })
  .inputValidator(WaitForCreditsApplicationInputZod)
  .handler(async ({ data }) => {
    const request = getRequest();
    const [{ authServer }, { kv }] = await Promise.all([import("~/lib/server/auth"), import("~/lib/server/kv")]);

    const authResponse = await authServer.api.getSession({ headers: request.headers }).catch(() => null);

    if (!authResponse?.user.id) {
      return { isAuthenticated: false } as const;
    }

    const appliedKey = CreditsRedisKey.creditApplied({
      checkoutId: data.checkoutId,
      userId: authResponse.user.id,
    });

    const maxWaitMs = 30_000;
    const pollIntervalMs = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const applied = await kv.get<string>(appliedKey);
      if (applied) {
        return { isApplied: true, isAuthenticated: true } as const;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return { isApplied: false, isAuthenticated: true } as const;
  });
