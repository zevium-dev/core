export const SIDEBAR_COOKIE_NAME = "sidebar_state";

import { createIsomorphicFn } from "@tanstack/react-start";

export const getSidebarDefaultOpen = createIsomorphicFn()
  .client(() => getSidebarDefaultOpenFromDocument() ?? true)
  .server(async () => {
    const { getCookie } = await import("@tanstack/react-start/server");
    return parseSidebarCookieValue(getCookie(SIDEBAR_COOKIE_NAME)) ?? true;
  });

export function getSidebarDefaultOpenFromDocument(): boolean | undefined {
  if (typeof document === "undefined") return undefined;

  const raw = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SIDEBAR_COOKIE_NAME}=`));

  if (!raw) return undefined;
  const value = raw.slice(`${SIDEBAR_COOKIE_NAME}=`.length);
  return parseSidebarCookieValue(decodeURIComponent(value));
}

export function parseSidebarCookieValue(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
