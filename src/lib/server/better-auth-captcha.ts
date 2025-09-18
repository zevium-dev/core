import type { BetterAuthPlugin } from "better-auth/plugins";

import { type } from "arktype";

import { cap } from "~/lib/server/cap";

export interface BaseCaptchaOptions {
  endpoints?: Array<string>;
}

export const defaultEndpoints = ["/sign-up/email", "/sign-in/email", "/forget-password"];

export const capCaptcha = (options?: BaseCaptchaOptions): BetterAuthPlugin => ({
  id: "cap-captcha",
  onRequest: async (request, ctx) => {
    try {
      const endpoints = options?.endpoints?.length ? options.endpoints : defaultEndpoints;
      if (!endpoints.some((endpoint) => request.url.includes(endpoint))) return undefined;
      const captchaToken = request.headers.get("x-captcha-token");
      const captchaSolutions = type("number[]")(request.headers.get("x-captcha-solutions")?.split(","));
      if (captchaSolutions instanceof type.errors) {
        return {
          response: Response.json({ message: "Missing CAPTCHA response" }, { status: 400 }),
        };
      }

      if (!captchaToken || !captchaSolutions.length) {
        return {
          response: Response.json({ message: "Missing CAPTCHA response" }, { status: 400 }),
        };
      }

      const challengeValid = await cap.redeemChallenge({ solutions: captchaSolutions, token: captchaToken });

      if (!challengeValid.success) {
        return {
          response: Response.json({ message: "Invalid CAPTCHA response" }, { status: 400 }),
        };
      }
    } catch (_error) {
      const errorMessage = _error instanceof Error ? _error.message : undefined;

      ctx.logger.error(errorMessage ?? "Unknown error", {
        endpoint: request.url,
        message: _error,
      });

      return { response: Response.json({ message: "Something went wrong" }, { status: 500 }) };
    }
  },
});
