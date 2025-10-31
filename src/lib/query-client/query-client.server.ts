import { cache } from "react";

import { makeQueryClient } from "./query-client.client";

export const cachedMakeQueryClient = cache(makeQueryClient);
