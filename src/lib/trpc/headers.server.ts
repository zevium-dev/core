import { getRequestHeaders } from "@tanstack/react-start/server";

export function getServerHeaders() {
  return getRequestHeaders();
}
