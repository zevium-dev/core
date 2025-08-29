import { useState } from "react";

import { auth } from "~/lib/auth";

import { AuthDialog } from "./auth-dialog";
import { Button } from "./ui/button";
import { EasyTooltip } from "./ui/easy-tooltip";

export const AccountButton = () => {
  const authState = auth.useSession();
  const [showAuthDialog, setShowAuthDialog] = useState(false);

  const emailAddress = authState.data?.user.email;

  const handleSignOut = async () => {
    await auth.signOut();
  };

  const handleSignInClick = () => {
    setShowAuthDialog(true);
  };

  return (
    <>
      <EasyTooltip asChild label={emailAddress ?? "Not logged in"}>
        <Button disabled={authState.isPending} onClick={authState.data ? handleSignOut : handleSignInClick} size="sm">
          {authState.data ? "Sign out" : "Sign in"}
        </Button>
      </EasyTooltip>

      <AuthDialog onOpenChange={setShowAuthDialog} open={showAuthDialog} />
    </>
  );
};
