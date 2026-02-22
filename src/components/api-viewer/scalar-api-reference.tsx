import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { ClientOnly } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useTheme } from "~/components/theme-provider";

interface ScalarApiReferenceProps {
  apiKey: string;
  className?: string;
  proxyUrl?: string;
  specUrl: string;
  upstreamHost: string;
}

interface ScalarConfiguration {
  darkMode?: boolean;
  layout?: "classic" | "modern";
  onBeforeRequest?: (options: { request: Request }) => void;
  proxyUrl?: string;
  url: string;
}

export function ScalarApiReference(props: ScalarApiReferenceProps) {
  return (
    <ClientOnly
      fallback={
        <div className="flex min-h-[640px] items-center justify-center rounded-lg border border-dashed">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-b-primary" />
        </div>
      }
    >
      <ScalarApiReferenceClient {...props} />
    </ClientOnly>
  );
}

function ScalarApiReferenceClient({
  apiKey,
  className,
  proxyUrl = "/api/proxy",
  specUrl,
  upstreamHost,
}: ScalarApiReferenceProps) {
  const { theme } = useTheme();

  const apiKeyRef = useRef(apiKey);
  const upstreamHostRef = useRef(upstreamHost);

  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);

  useEffect(() => {
    upstreamHostRef.current = upstreamHost;
  }, [upstreamHost]);

  const isDarkMode =
    theme === "dark" ||
    (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const configuration = useMemo<ScalarConfiguration>(() => {
    return {
      darkMode: isDarkMode,
      onBeforeRequest: ({ request }) => {
        const currentApiKey = apiKeyRef.current.trim();
        if (currentApiKey.length > 0) {
          request.headers.set("X-Zevium-Key", currentApiKey);
        }

        const currentUpstreamHost = upstreamHostRef.current.trim();
        if (currentUpstreamHost.length > 0) {
          request.headers.set("X-Zevium-Host", currentUpstreamHost);
        }
      },
      proxyUrl,
      url: specUrl,
    };
  }, [isDarkMode, proxyUrl, specUrl]);

  return (
    <div className={className}>
      <ApiReferenceReact configuration={configuration} />
    </div>
  );
}
