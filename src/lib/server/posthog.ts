import { PostHog } from "posthog-node";

import { serverEnv } from "~/env/server";

export function createPostHogClient() {
  if (!serverEnv.VITE_PUBLIC_POSTHOG_KEY) {
    return null;
  }

  const posthog = new PostHog(serverEnv.VITE_PUBLIC_POSTHOG_KEY, {
    flushAt: 1, // Send events immediately in edge environment
    flushInterval: 0, // Don't wait for interval
    host: "https://us.i.posthog.com",
  });

  return posthog;
}
