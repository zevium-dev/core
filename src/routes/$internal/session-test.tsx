import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { auth, useUser } from "~/lib/auth";

export const Route = createFileRoute("/$internal/session-test")({
  component: RouteComponent,
});

const getSession = async () => {
  if (typeof window === "undefined") {
    const { authServer } = await import("~/lib/server/auth");
    const { getWebRequest } = await import("@tanstack/react-start/server");
    const request = getWebRequest();
    const { session, user } = await authServer.api.getSession({ headers: request.headers });
    return { session, user };
  } else {
    const session = await auth.getSession();
    return { session: session.data?.session, user: session.data?.user };
  }
};

const useSession = () => {
  return useSuspenseQuery({
    queryFn: getSession,
    queryKey: ["session"],
  });
};

function RouteComponent() {
  const sessionQuery = useSession();
  const user = useUser();
  return (
    <div className="flex gap-4">
      <div className="max-h-96 max-w-96 overflow-auto">
        <code>
          <pre>{JSON.stringify(sessionQuery.data, null, 2)}</pre>
        </code>
      </div>
      <div className="max-h-96 max-w-96 overflow-auto">
        <code>
          <pre>{JSON.stringify(user, null, 2)}</pre>
        </code>
      </div>
    </div>
  );
}
