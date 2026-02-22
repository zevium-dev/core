import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ScalarApiReference } from "~/components/api-viewer/scalar-api-reference";
import { PageHeaderContent } from "~/components/sidebar";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";

const API_KEY_STORAGE_KEY = "zevium:api-explorer:key";

interface OpenApiServer {
  url?: string;
}

const getStorageValue = (key: string) => {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(key) ?? "";
};

const getHostFromServerUrl = (serverUrl?: string) => {
  if (!serverUrl) return "";

  try {
    return new URL(serverUrl).host;
  } catch {
    return "";
  }
};

const readErrorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/$projectSlug/explorer")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(
      context.trpc.project.get.queryOptions({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    );
  },
});

function RouteComponent() {
  const { organizationSlug, projectSlug } = Route.useParams();
  const trpc = useTRPC();

  const projectQuery = useSuspenseQuery(
    trpc.project.get.queryOptions({
      organizationSlug,
      projectSlug,
    }),
  );

  const specUrl = `/api/projects/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(projectSlug)}/openapi`;
  const hostStorageKey = `zevium:api-explorer:host:${organizationSlug}:${projectSlug}`;

  const [apiKey, setApiKey] = useState(() => getStorageValue(API_KEY_STORAGE_KEY));
  const [upstreamHost, setUpstreamHost] = useState(() => getStorageValue(hostStorageKey));

  const detectedHostQuery = useQuery({
    enabled: typeof window !== "undefined",
    queryFn: async () => {
      const response = await fetch(specUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const body = (await response.json()) as { servers?: Array<OpenApiServer> };
      return getHostFromServerUrl(body.servers?.at(0)?.url);
    },
    queryKey: ["api-explorer-detected-host", organizationSlug, projectSlug],
    staleTime: 60_000,
  });

  const effectiveUpstreamHost = upstreamHost.trim().length > 0 ? upstreamHost : (detectedHostQuery.data ?? "");
  const hostPlaceholder =
    detectedHostQuery.data && detectedHostQuery.data.length > 0 ? detectedHostQuery.data : "api.example.com";

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(hostStorageKey, upstreamHost);
  }, [hostStorageKey, upstreamHost]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:p-6">
      <PageHeaderContent>
        <Typography variant="large">{projectQuery.data.name} &gt; API Explorer</Typography>
      </PageHeaderContent>

      <Card className="shrink-0">
        <CardHeader>
          <CardTitle>Try Requests</CardTitle>
          <CardDescription>
            Set your API key and upstream host once, then use Scalar&apos;s request panel to test endpoints.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="zevium-api-key">Zevium API Key</Label>
            <div className="relative">
              <KeyRound className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoComplete="off"
                className="pl-9"
                id="zevium-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="zev_..."
                type="password"
                value={apiKey}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="upstream-host">Upstream Host</Label>
            <div className="relative">
              <Link2 className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoComplete="off"
                className="pl-9"
                id="upstream-host"
                onChange={(event) => setUpstreamHost(event.target.value)}
                placeholder={hostPlaceholder}
                value={upstreamHost}
              />
            </div>
          </div>

          {detectedHostQuery.error ? (
            <Alert className="sm:col-span-2" variant="destructive">
              <AlertTitle>Could not detect host from published spec</AlertTitle>
              <AlertDescription>
                {detectedHostQuery.error.message} Ensure your published spec has a valid `servers[0].url`, or enter host
                manually.
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="text-xs text-muted-foreground sm:col-span-2">
            Need a key? Create one in{" "}
            <Link className="underline" to="/app/settings/keys">
              Settings &gt; Keys
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <ScalarApiReference
            apiKey={apiKey}
            className="min-h-[70vh] w-full"
            specUrl={specUrl}
            upstreamHost={effectiveUpstreamHost}
          />
        </CardContent>
      </Card>
    </div>
  );
}
