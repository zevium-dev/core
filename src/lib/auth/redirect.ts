export type AllowedRedirectTo = "/app" | "/app/invitations";

export const getSafeRedirectTo = (redirectTo: string | undefined): AllowedRedirectTo => {
  return redirectTo === "/app/invitations" ? "/app/invitations" : "/app";
};
