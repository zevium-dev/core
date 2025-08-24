import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";

import { clientEnv } from "~/env/client";
import { auth } from "~/lib/auth";

export const PostHogIdentify = () => {
  const ph = usePostHog();
  const authState = auth.useSession();

  useEffect(() => {
    if (!clientEnv.VITE_PUBLIC_POSTHOG_KEY) return;
    if (authState.data?.user) {
      ph.identify(authState.data.user.id, {
        avatar: authState.data.user.image,
        email: authState.data.user.email,
        name: authState.data.user.name,
      });
    }
  }, [authState.data?.user, ph]);

  return null;
};
