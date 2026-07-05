import defaultServerEntry from "@tanstack/react-start/server-entry";

export default {
  fetch: (request: Request) => defaultServerEntry.fetch(request),
} satisfies ExportedHandler;
