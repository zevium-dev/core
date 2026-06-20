import { createServerOnlyFn } from "@tanstack/react-start";
import { cache } from "react";

import { makeQueryClient } from "./query-client";

export const getServerQueryClient = createServerOnlyFn(cache(makeQueryClient));
