import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { trustedCatalogueSearch } from "./catalogue-search.server";
export const publicSemanticSearch = createServerFn({ method: "POST" })
  .inputValidator(z.strictObject({ query: z.string().trim().min(1).max(200) }))
  .handler(({ data }) => trustedCatalogueSearch(data.query));
