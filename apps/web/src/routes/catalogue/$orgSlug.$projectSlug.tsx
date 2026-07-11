import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  extractPricing,
  parseSpec,
  type HttpMethod,
  type OpenApiOperation,
} from "@zevium/shared";
import { Check, Copy, PackageX, Terminal, TriangleAlert } from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { toast } from "sonner";

import { PublicHeader } from "#/components/public-header";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { Switch } from "#/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import {
  buildMcpConfigSnippet,
  mcpEndpointUrl,
  resolveGatewayOrigin,
  tryItBaseUrl,
} from "#/lib/landing";

const API_KEY_STORAGE = "zevium:playground-api-key";
const DEFAULT_GATEWAY = "http://localhost:8787/gateway";

const TEXTAREA_CLASS =
  "flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export const Route = createFileRoute("/catalogue/$orgSlug/$projectSlug")({
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(api.catalogue.getPublicDetail, {
      orgSlug: params.orgSlug,
      projectSlug: params.projectSlug,
    });
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);
      return;
    }
    await queryClient.ensureQueryData(queryOpts);
  },
  component: ApiDetailPage,
  head: ({ params }) => ({
    meta: [
      {
        title: `${params.projectSlug} · Catalogue · Zevium`,
      },
      {
        name: "description",
        content: "API pricing, docs, and try-it playground.",
      },
    ],
  }),
  pendingComponent: ApiDetailSkeleton,
});

type EndpointRow = {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string | undefined;
  cost: number;
  freeTier: number | undefined;
  pathParams: string[];
};

type PlayResult = {
  status: number;
  statusText: string;
  ms: number;
  body: string;
  mock: boolean;
};

function gatewayBaseUrl(): string {
  const env = import.meta.env.VITE_GATEWAY_URL;
  if (typeof env === "string" && env.trim().length > 0) {
    return env.replace(/\/+$/, "");
  }
  return DEFAULT_GATEWAY;
}

function listEndpoints(specJson: string): EndpointRow[] {
  const spec = parseSpec(specJson);
  const rows: EndpointRow[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (op === undefined) continue;
      const operation = op as OpenApiOperation;
      const pricing = extractPricing(operation);
      const pathParams = Array.from(path.matchAll(/\{([^}/]+)\}/g)).map(
        (m) => m[1]!,
      );
      rows.push({
        id: `${method}:${path}`,
        method: method as HttpMethod,
        path,
        summary:
          typeof operation.summary === "string" ? operation.summary : undefined,
        cost: pricing.cost,
        freeTier: pricing.freeTier,
        pathParams,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });
  return rows;
}

function buildRequestPath(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{([^}/]+)\}/g, (_, name: string) => {
    const value = params[name] ?? "";
    return encodeURIComponent(value);
  });
}

function parseExtraHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key.length > 0) headers[key] = value;
  }
  return headers;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCurl(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}): string {
  const parts = [
    `curl -X ${opts.method.toUpperCase()} ${shellQuote(opts.url)}`,
  ];
  for (const [k, v] of Object.entries(opts.headers)) {
    parts.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (opts.body !== undefined && opts.body.length > 0) {
    parts.push(`  -d ${shellQuote(opts.body)}`);
  }
  return parts.join(" \\\n");
}

async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("Could not copy to clipboard");
  }
}

function ApiDetailPage() {
  const { orgSlug, projectSlug } = Route.useParams();

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader maxWidthClass="max-w-6xl" active="catalogue" />

      <main className="mx-auto max-w-6xl px-4 py-8 content-enter">
        <Suspense fallback={<ApiDetailBodySkeleton />}>
          <ApiDetailBody orgSlug={orgSlug} projectSlug={projectSlug} />
        </Suspense>
      </main>
    </div>
  );
}

function ApiDetailBody({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.getPublicDetail, { orgSlug, projectSlug }),
  );

  const endpoints = useMemo(() => {
    if (data === null || data.latestVersion === null)
      return [] as EndpointRow[];
    try {
      return listEndpoints(data.latestVersion.spec);
    } catch {
      return [] as EndpointRow[];
    }
  }, [data]);

  const priceRange = useMemo(() => {
    if (endpoints.length === 0) return null;
    let min = endpoints[0]!.cost;
    let max = endpoints[0]!.cost;
    for (const ep of endpoints) {
      min = Math.min(min, ep.cost);
      max = Math.max(max, ep.cost);
    }
    return min === max ? `${min} credits` : `${min}–${max} credits`;
  }, [endpoints]);

  if (data === null) {
    return <ApiNotFound />;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-muted-foreground">
              <Link to="/catalogue" className="hover:text-foreground link-draw">
                Catalogue
              </Link>
              <span className="mx-1.5 text-muted-foreground/60">/</span>
              <span className="font-mono text-xs">
                {data.org.slug}/{data.project.slug}
              </span>
            </p>
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{
                viewTransitionName: `api-title-${data.project.slug}`,
              }}
            >
              {data.project.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              by{" "}
              <span className="font-medium text-foreground">
                {data.org.name}
              </span>
              {data.latestVersion ? (
                <> · v{data.latestVersion.version}</>
              ) : null}
              {priceRange ? (
                <>
                  {" "}
                  ·{" "}
                  <span className="tabular-nums text-foreground">
                    {priceRange}
                  </span>
                </>
              ) : null}
            </p>
            {data.project.description ? (
              <p className="max-w-2xl text-sm text-muted-foreground">
                {data.project.description}
              </p>
            ) : null}
          </div>
          <Badge variant="secondary" className="shrink-0">
            {data.org.name}
          </Badge>
        </div>

        {data.project.tags.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {data.project.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {data.latestVersion?.deprecatedAt !== undefined ? (
        <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-warning-foreground">
              Deprecated
              {data.latestVersion.sunsetAt !== undefined
                ? ` — sunset ${new Date(data.latestVersion.sunsetAt).toLocaleDateString()}`
                : ""}
            </p>
            {data.latestVersion.deprecationMessage ? (
              <p className="text-muted-foreground">
                {data.latestVersion.deprecationMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <PricingTable endpoints={endpoints} />

      <Tabs defaultValue="docs" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="docs">Docs</TabsTrigger>
          <TabsTrigger value="try-it">Try it</TabsTrigger>
          <TabsTrigger value="agent">Connect your agent</TabsTrigger>
        </TabsList>

        <TabsContent value="docs" className="mt-2">
          <EndpointDocs endpoints={endpoints} />
        </TabsContent>

        <TabsContent value="try-it" className="mt-2">
          <TryItPanel
            orgSlug={data.org.slug}
            projectSlug={data.project.slug}
            endpoints={endpoints}
          />
        </TabsContent>

        <TabsContent value="agent" className="mt-2">
          <ConnectAgentPanel
            orgSlug={data.org.slug}
            projectSlug={data.project.slug}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PricingTable({ endpoints }: { endpoints: EndpointRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pricing</CardTitle>
        <CardDescription>
          Per-endpoint credits from the published OpenAPI spec (
          <span className="font-mono text-xs">x-zevium-cost</span>
          ).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No priced endpoints in the published spec yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 font-medium">Summary</th>
                  <th className="px-3 py-2 font-medium tabular-nums">
                    Credits
                  </th>
                  <th className="px-3 py-2 font-medium">Free tier</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((ep) => (
                  <tr key={ep.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <MethodBadge method={ep.method} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{ep.path}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {ep.summary ?? "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{ep.cost}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {ep.freeTier !== undefined && ep.freeTier > 0
                        ? `${ep.freeTier}/day`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EndpointDocs({ endpoints }: { endpoints: EndpointRow[] }) {
  if (endpoints.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Endpoints</CardTitle>
          <CardDescription>
            Published spec has no operations to document.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Endpoints</CardTitle>
        <CardDescription>
          Operation list with method badges, summaries, and per-call credits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {endpoints.map((ep) => (
          <div
            key={ep.id}
            className="flex flex-wrap items-start gap-3 rounded-lg border px-3 py-3"
          >
            <MethodBadge method={ep.method} />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-mono text-sm">{ep.path}</p>
              {ep.summary ? (
                <p className="text-sm text-muted-foreground">{ep.summary}</p>
              ) : null}
            </div>
            <Badge variant="secondary" className="tabular-nums">
              {ep.cost} credit{ep.cost === 1 ? "" : "s"}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function MethodBadge({ method }: { method: string }) {
  return (
    <Badge variant="outline" className="font-mono uppercase tracking-wide">
      {method}
    </Badge>
  );
}

function TryItPanel({
  orgSlug,
  projectSlug,
  endpoints,
}: {
  orgSlug: string;
  projectSlug: string;
  endpoints: EndpointRow[];
}) {
  const [endpointId, setEndpointId] = useState(endpoints[0]?.id ?? "");
  const endpoint =
    endpoints.find((e) => e.id === endpointId) ?? endpoints[0] ?? null;

  const [pathParams, setPathParams] = useState<Record<string, string>>({});
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("{\n  \n}");
  const [apiKey, setApiKey] = useState("");
  const [mock, setMock] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(API_KEY_STORAGE);
      if (stored) setApiKey(stored);
    } catch {
      // sessionStorage may be blocked
    }
  }, []);

  useEffect(() => {
    if (!endpoint) return;
    setPathParams((prev) => {
      const next: Record<string, string> = {};
      for (const name of endpoint.pathParams) {
        next[name] = prev[name] ?? "";
      }
      return next;
    });
  }, [endpoint]);

  const onApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    try {
      if (value.trim() === "") {
        sessionStorage.removeItem(API_KEY_STORAGE);
      } else {
        sessionStorage.setItem(API_KEY_STORAGE, value);
      }
    } catch {
      // ignore
    }
  }, []);

  const requestUrl = useMemo(() => {
    if (!endpoint) return "";
    const path = buildRequestPath(endpoint.path, pathParams);
    const base = tryItBaseUrl(gatewayBaseUrl(), mock);
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}/${orgSlug}/${projectSlug}${suffix}`;
  }, [endpoint, pathParams, orgSlug, projectSlug, mock]);

  const needsBody =
    endpoint !== null &&
    (endpoint.method === "post" ||
      endpoint.method === "put" ||
      endpoint.method === "patch");

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!endpoint || sending) return;

    const headers = parseExtraHeaders(headersText);
    const key = apiKey.trim();
    if (key.length > 0) {
      headers.Authorization = `Bearer ${key}`;
      headers["X-Api-Key"] = key;
    }

    const init: RequestInit = {
      method: endpoint.method.toUpperCase(),
      headers,
    };
    let body: string | undefined;
    if (needsBody && bodyText.trim().length > 0) {
      body = bodyText;
      if (
        headers["Content-Type"] === undefined &&
        headers["content-type"] === undefined
      ) {
        headers["Content-Type"] = "application/json";
      }
      init.body = body;
    }

    setSending(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const res = await fetch(requestUrl, init);
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      setResult({
        status: res.status,
        statusText: res.statusText,
        ms,
        body: text,
        mock,
      });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      setResult({
        status: 0,
        statusText: "Network error",
        ms,
        body: humanError(err, "Request failed. Check gateway URL and CORS."),
        mock,
      });
    } finally {
      setSending(false);
    }
  }

  function onCopyCurl() {
    if (!endpoint) return;
    const headers = parseExtraHeaders(headersText);
    const key = apiKey.trim();
    if (key.length > 0) {
      headers.Authorization = `Bearer ${key}`;
      headers["X-Api-Key"] = key;
    }
    let body: string | undefined;
    if (needsBody && bodyText.trim().length > 0) {
      body = bodyText;
      if (
        headers["Content-Type"] === undefined &&
        headers["content-type"] === undefined
      ) {
        headers["Content-Type"] = "application/json";
      }
    }
    const curl = buildCurl({
      method: endpoint.method,
      url: requestUrl,
      headers,
      body,
    });
    void copyText(curl, "curl copied").then(() => {
      setCopiedCurl(true);
      window.setTimeout(() => setCopiedCurl(false), 1500);
    });
  }

  if (endpoints.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Try it</CardTitle>
          <CardDescription>
            No endpoints available to call from the published spec.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Try it</CardTitle>
        <CardDescription>
          Live playground. Calls hit the metered gateway and charge credits.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={onSend}>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <div className="space-y-0.5">
              <Label htmlFor="try-mock-toggle">Mock</Label>
              <p className="text-xs text-muted-foreground">
                Serve a generated example from the spec — no upstream call, no
                credits.
              </p>
            </div>
            <Switch
              id="try-mock-toggle"
              checked={mock}
              onCheckedChange={setMock}
            />
          </div>

          {mock ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
            >
              <Badge variant="secondary">mock response · 0 credits</Badge>
              <span>
                Calls hit <span className="font-mono text-xs">/mock</span> — no
                API key needed, never touches upstream.
              </span>
            </div>
          ) : (
            <div
              role="status"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              Real call — charged against your org wallet. Key stays in session
              storage only.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="try-endpoint">Endpoint</Label>
              <select
                id="try-endpoint"
                value={endpoint?.id ?? ""}
                onChange={(e) => setEndpointId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.method.toUpperCase()} {ep.path} · {ep.cost} credit
                    {ep.cost === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </div>

            {endpoint?.pathParams.map((name) => (
              <div key={name} className="space-y-2">
                <Label htmlFor={`param-${name}`}>{name}</Label>
                <Input
                  id={`param-${name}`}
                  name={name}
                  value={pathParams[name] ?? ""}
                  onChange={(e) =>
                    setPathParams((prev) => ({
                      ...prev,
                      [name]: e.target.value,
                    }))
                  }
                  placeholder={name}
                  className="font-mono text-sm"
                />
              </div>
            ))}

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="api-key">API key</Label>
              <Input
                id="api-key"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="API key"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Stored in this browser session only. Never sent to Convex.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="try-headers">Headers</Label>
              <textarea
                id="try-headers"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={"Accept: application/json"}
                rows={3}
                className={TEXTAREA_CLASS}
              />
            </div>

            {needsBody ? (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="try-body">Body</Label>
                <textarea
                  id="try-body"
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className={TEXTAREA_CLASS}
                />
              </div>
            ) : null}
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">Request URL</p>
            <p className="mt-1 break-all font-mono text-xs">{requestUrl}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={sending || !endpoint}>
              {sending ? "Sending…" : "Send"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCopyCurl}
              disabled={!endpoint}
            >
              {copiedCurl ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              Copy as curl
            </Button>
          </div>

          {result ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={
                    result.status >= 200 && result.status < 300
                      ? "secondary"
                      : "destructive"
                  }
                  className="tabular-nums"
                >
                  {result.status || "ERR"} {result.statusText}
                </Badge>
                {result.mock ? (
                  <Badge variant="outline">mock response · 0 credits</Badge>
                ) : null}
                <span className="text-muted-foreground tabular-nums">
                  {result.ms} ms
                </span>
              </div>
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                {result.body || "(empty body)"}
              </pre>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function ConnectAgentPanel({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const gatewayOrigin = resolveGatewayOrigin(
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
  );
  const mcpUrl = mcpEndpointUrl(gatewayOrigin);
  const snippet = buildMcpConfigSnippet(mcpUrl);

  const notes = `// Agent notes for ${orgSlug}/${projectSlug}
// 1. Search catalogue with tool search_apis({ query })
// 2. Load docs with get_api_docs({ org: "${orgSlug}", project: "${projectSlug}" })
// 3. Call via call_api — same key-authenticated, credit-gated gateway as humans
// Gateway base: ${gatewayBaseUrl()}/${orgSlug}/${projectSlug}`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-4" />
            MCP config
          </CardTitle>
          <CardDescription>
            Paste into your agent client. Replace YOUR_API_KEY with a Zevium
            key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre">
            {snippet}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyText(snippet, "MCP config copied")}
          >
            <Copy className="size-4" />
            Copy config
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage notes</CardTitle>
          <CardDescription>
            Agent-readable connection path for this API.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
            {notes}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyText(notes, "Usage notes copied")}
          >
            <Copy className="size-4" />
            Copy notes
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ApiNotFound() {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center py-16 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <PackageX className="size-6 text-muted-foreground" />
        </div>
        <CardTitle>API not found</CardTitle>
        <CardDescription className="max-w-sm">
          This listing is missing, private, or unpublished. Browse the public
          catalogue for live APIs.
        </CardDescription>
        <div className="pt-4">
          <Button asChild variant="outline">
            <Link to="/catalogue">Back to catalogue</Link>
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}

function ApiDetailBodySkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
      <Skeleton className="h-9 w-72" />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function ApiDetailSkeleton() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <ApiDetailBodySkeleton />
      </main>
    </div>
  );
}
