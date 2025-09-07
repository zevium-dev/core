import { createClerkHandler } from "@clerk/tanstack-react-start/server";
import { createStartHandler, defaultStreamHandler, defineHandlerCallback } from "@tanstack/react-start/server";

import { createRouter } from "./router";

// @ts-expect-error wrong types
const handlerFactory = createClerkHandler(createStartHandler({ createRouter }));

export default defineHandlerCallback(async (event) => {
  // @ts-expect-error wrong types
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const startHandler = await handlerFactory(defaultStreamHandler);
  return startHandler(event);
});
