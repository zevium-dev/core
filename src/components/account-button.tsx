import { auth } from "~/lib/auth";

import { Button } from "./ui/button";
import { EasyTooltip } from "./ui/easy-tooltip";

export const AccountButton = () => {
  const authState = auth.useSession();

  const emailAddress = authState.data?.user.email;

  const handleSignIn = async () => {
    await auth.signIn.social({ provider: "google" });
  };

  const handleSignOut = async () => {
    await auth.signOut();
  };

  return (
    <EasyTooltip asChild label={emailAddress ?? "Not logged in"}>
      <Button disabled={authState.isPending} onClick={authState.data ? handleSignOut : handleSignIn} size="sm">
        {authState.data ? "Sign out" : "Sign in"}
      </Button>
    </EasyTooltip>
  );
};
