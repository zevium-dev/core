import { createFileRoute } from "@tanstack/react-router";

import { createChallenge, redeemChallenge, type Solution } from "~/lib/server/cap";

export const Route = createFileRoute("/api/cap/$")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.url.includes("challenge")) {
          const challenge = await createChallenge();
          return Response.json(challenge);
        } else if (request.url.includes("redeem")) {
          const body = (await request.json()) as Solution;
          const response = await redeemChallenge(body);
          return Response.json(response);
        }
      },
    },
  },
});
