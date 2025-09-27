import { createFileRoute } from "@tanstack/react-router";

import { cap, type Solution } from "~/lib/server/cap";

export const Route = createFileRoute("/api/cap/$")({
  server: {
    handlers: {
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
    },
  },
});
