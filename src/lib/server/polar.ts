import { Polar } from "@polar-sh/sdk";

import { serverEnv } from "~/env/server";

export const polarClient = new Polar({
  accessToken: serverEnv.POLAR_ACCESS_TOKEN,
  server: serverEnv.POLAR_SERVER,
});
