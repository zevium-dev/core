export const SIDEBAR_COOKIE_NAME = "sidebar_state";

export async function getSidebarDefaultOpen(): Promise<boolean> {
  // Client bundle: never import server modules.
  if (!import.meta.env.SSR) {
    return getSidebarDefaultOpenFromDocument() ?? true;
  }

  const { getCookie } = await import("@tanstack/react-start/server");
  return parseSidebarCookieValue(getCookie(SIDEBAR_COOKIE_NAME)) ?? true;
}

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
