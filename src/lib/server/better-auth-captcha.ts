import type { BetterAuthPlugin } from "better-auth/plugins";

import { CAPTCHA_HEADER_KEY } from "~/lib/constants";
import { cap } from "~/lib/server/cap";

export interface BaseCaptchaOptions {
  endpoints?: Array<string>;
}

export const defaultEndpoints = ["/sign-up/email", "/sign-in/email", "/forget-password", "/send-verification-email"];

export const capCaptcha = (options?: BaseCaptchaOptions): BetterAuthPlugin => ({
  id: "cap-captcha",
  onRequest: async (request, ctx) => {
    try {
      const endpoints = options?.endpoints?.length ? options.endpoints : defaultEndpoints;
      if (!endpoints.some((endpoint) => request.url.includes(endpoint))) return undefined;
      const captchaToken = request.headers.get(CAPTCHA_HEADER_KEY);

      if (!captchaToken) {
        return {
          response: Response.json({ message: "Captcha validation failed" }, { status: 400 }),
        };
      }

      const challengeValid = await cap.validateToken(captchaToken);

      if (!challengeValid.success) {
        return {
          response: Response.json({ message: "Captcha validation failed" }, { status: 400 }),
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
