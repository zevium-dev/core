import { createServerFileRoute } from "@tanstack/react-start/server";

import { cap, type Solution } from "~/lib/server/cap";

export const ServerRoute = createServerFileRoute("/api/cap/$").methods({
  POST: async ({ request }) => {
    if (request.url.includes("challenge")) {
      const challenge = await cap.createChallenge();
      return Response.json(challenge);
    } else if (request.url.includes("redeem")) {
      const { solutions, token } = (await request.json()) as Solution;
      const response = await cap.redeemChallenge({ solutions, token });
      return Response.json(response);
    }
  },
});
