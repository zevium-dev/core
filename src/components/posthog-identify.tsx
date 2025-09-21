import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";

import { clientEnv } from "~/env/client";
import { useUser } from "~/lib/auth";

export const PostHogIdentify = () => {
  const ph = usePostHog();
  const user = useUser();

  useEffect(() => {
    if (!clientEnv.VITE_PUBLIC_POSTHOG_KEY) return;
    if (user) {
      ph.identify(user.id, {
        avatar: user.image,
        email: user.email,
        name: user.name,
      });
    }
  }, [user, ph]);

  return null;
};
