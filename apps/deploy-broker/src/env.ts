import { invariant } from "./errors";
import {
  BROKER_SCRIPT_NAME,
  CLOUDFLARE_ACCOUNT_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  GITHUB_REPOSITORY_OWNER_ID,
} from "./manifest";

export const BROKER_ORIGIN = "https://deploy-broker.zevium.dev";

export interface BrokerEnv {
  AUTH_RATE_LIMIT: DurableObjectNamespace;
  BROKER_ORIGIN: string;
  BROKER_SCRIPT_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_BROKER_API_TOKEN?: string;
  GITHUB_REPOSITORY: string;
  GITHUB_REPOSITORY_ID: string;
  GITHUB_REPOSITORY_OWNER_ID: string;
  SESSIONS: DurableObjectNamespace;
}

export function validateEnvironment(
  env: BrokerEnv,
  options: { requireCloudflareToken: boolean },
): void {
  invariant(
    env.BROKER_ORIGIN === BROKER_ORIGIN &&
      env.BROKER_SCRIPT_NAME === BROKER_SCRIPT_NAME &&
      env.CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_ACCOUNT_ID &&
      env.GITHUB_REPOSITORY === GITHUB_REPOSITORY &&
      env.GITHUB_REPOSITORY_ID === GITHUB_REPOSITORY_ID &&
      env.GITHUB_REPOSITORY_OWNER_ID === GITHUB_REPOSITORY_OWNER_ID,
    503,
    "configuration_rejected",
    "Deployment broker immutable configuration differs",
  );
  if (options.requireCloudflareToken) {
    invariant(
      typeof env.CLOUDFLARE_BROKER_API_TOKEN === "string" &&
        env.CLOUDFLARE_BROKER_API_TOKEN.length >= 20 &&
        env.CLOUDFLARE_BROKER_API_TOKEN.length <= 512 &&
        !/\s/.test(env.CLOUDFLARE_BROKER_API_TOKEN),
      503,
      "broker_token_unavailable",
      "Deployment broker credential is unavailable",
    );
  }
}
