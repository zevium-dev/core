import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Copy, PackageX, Terminal, TriangleAlert } from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { PublicHeader } from "#/components/public-header";
import { SyntaxCode } from "#/components/syntax-code";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { Textarea } from "#/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { api } from "#/lib/convex-api";
import { creditsLabel } from "#/lib/credits-label";
import {
  buildMcpConfigSnippet,
  mcpEndpointUrl,
  resolveGatewayOrigin,
  tryItBaseUrl,
} from "#/lib/landing";
import {
  appendQueryParameters,
  buildRequestPath,
  parsePublishedEndpoints,
  readableJsonResponse,
  sanitizedGatewayErrorResponse,
  type ApiEndpoint,
  type ApiParameter,
} from "#/lib/openapi-reference";

const API_KEY_STORAGE = "zevium:playground-api-key";
const DEFAULT_GATEWAY = "http://localhost:8787/gateway";
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function responseLanguage(body: string): "json" | "plain" {
  try {
    JSON.parse(body);
    return "json";
  } catch {
    return "plain";
  }
}

type EndpointRow = ApiEndpoint;
type ApiDetailTab = "try" | "docs" | "agent";
type PlaygroundMode = "mock" | "live";
type ApiDetailSearch = {
  tab: ApiDetailTab;
  mode: PlaygroundMode;
  operation?: string;
};

export const Route = createFileRoute(
  "/catalogue/$publisherHandle/$projectSlug",
)({
  validateSearch: (search: Record<string, unknown>): ApiDetailSearch => ({
    tab: search.tab === "docs" || search.tab === "agent" ? search.tab : "try",
    mode: search.mode === "live" ? "live" : "mock",
    operation:
      typeof search.operation === "string" ? search.operation : undefined,
  }),
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(api.catalogue.getPublicDetail, {
      publisherHandle: params.publisherHandle,
      projectSlug: params.projectSlug,
    });
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);
      return;
    }
    try {
      await queryClient.ensureQueryData(queryOpts);
    } catch {
      // Keep transient Convex failures inside product UI instead of leaking
      // TanStack's raw server error page.
    }
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

type PlayResult = {
  status: number;
  statusText: string;
  ms: number;
  body: string;
  mock: boolean;
  contentType: string | null;
  requestId?: string;
};

function gatewayBaseUrl(): string {
  const env = import.meta.env.VITE_GATEWAY_URL;
  if (typeof env === "string" && env.trim().length > 0) {
    return env.replace(/\/+$/, "");
  }
  return DEFAULT_GATEWAY;
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

function invalidHeaderLine(raw: string): boolean {
  return raw.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && trimmed.indexOf(":") <= 0;
  });
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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function parameterInputId(endpointId: string, parameter: ApiParameter): string {
  return `try-${endpointId}-${parameter.key}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function liveCostLabel(endpoint: EndpointRow | null): string {
  if (endpoint === null) return "cost unavailable";
  if (endpoint.freeTier !== undefined) {
    return `up to ${creditsLabel(endpoint.cost)}`;
  }
  return creditsLabel(endpoint.cost);
}

function ApiDetailPage() {
  const { publisherHandle, projectSlug } = Route.useParams();

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader active="catalogue" />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-8 outline-none content-enter"
      >
        <Suspense fallback={<ApiDetailBodySkeleton />}>
          <ApiDetailBody
            publisherHandle={publisherHandle}
            projectSlug={projectSlug}
          />
        </Suspense>
      </main>
    </div>
  );
}

function ApiDetailBody({
  publisherHandle,
  projectSlug,
}: {
  publisherHandle: string;
  projectSlug: string;
}) {
  const routeSearch = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.getPublicDetail, {
      publisherHandle,
      projectSlug,
    }),
  );

  const endpoints = useMemo(() => {
    if (data === null || data.latestVersion === null)
      return [] as EndpointRow[];
    try {
      return parsePublishedEndpoints(data.latestVersion.spec);
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
    return min === max ? creditsLabel(min) : `${min}–${max} credits`;
  }, [endpoints]);

  const selectedEndpointId =
    endpoints.find((endpoint) => endpoint.id === routeSearch.operation)?.id ??
    endpoints[0]?.id ??
    "";

  const setTab = (tab: ApiDetailTab) => {
    void navigate({
      search: { ...routeSearch, tab },
      replace: true,
    });
  };

  const setOperation = (operation: string) => {
    void navigate({
      search: { ...routeSearch, operation },
      replace: true,
    });
  };

  const setMode = (mode: PlaygroundMode) => {
    void navigate({
      search: { ...routeSearch, mode },
      replace: true,
    });
  };

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
                {data.org.publisherHandle}/{data.project.slug}
              </span>
            </p>
            <h1
              className="min-w-0 text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]"
              style={{
                viewTransitionName: `api-title-${data.org.publisherHandle}-${data.project.slug}`,
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
                  <span
                    className="tabular-nums text-foreground"
                    style={{
                      viewTransitionName: `api-price-${data.org.publisherHandle}-${data.project.slug}`,
                    }}
                  >
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
        <p className="text-xs text-muted-foreground">
          Runtime reliability and publisher verification are not reported yet.
          Start with the keyless mock before choosing a live call.
        </p>
      </div>

      {data.latestVersion?.deprecatedAt !== undefined ? (
        <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-warning-foreground">
              Deprecated
              {data.latestVersion.sunsetAt !== undefined
                ? ` — sunset ${DATE_FORMATTER.format(data.latestVersion.sunsetAt)}`
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

      <Tabs
        value={routeSearch.tab}
        onValueChange={(value) => {
          if (value === "try" || value === "docs" || value === "agent") {
            setTab(value);
          }
        }}
        className="gap-4"
      >
        <TabsList
          variant="line"
          aria-label="API tools"
          className="max-w-full justify-start overflow-x-auto"
        >
          <TabsTrigger value="try">Try it</TabsTrigger>
          <TabsTrigger value="docs">Reference</TabsTrigger>
          <TabsTrigger value="agent">Connect your agent</TabsTrigger>
        </TabsList>

        <TabsContent value="try" className="mt-2">
          <TryItPanel
            publisherHandle={data.org.publisherHandle}
            projectSlug={data.project.slug}
            endpoints={endpoints}
            endpointId={selectedEndpointId}
            mode={routeSearch.mode}
            onEndpointChange={setOperation}
            onModeChange={setMode}
          />
        </TabsContent>

        <TabsContent value="docs" className="mt-2">
          <EndpointDocs
            endpoints={endpoints}
            onTry={(operation) => {
              void navigate({
                search: {
                  ...routeSearch,
                  tab: "try",
                  mode: "mock",
                  operation,
                },
              });
            }}
          />
        </TabsContent>

        <TabsContent value="agent" className="mt-2">
          <ConnectAgentPanel
            publisherHandle={data.org.publisherHandle}
            projectSlug={data.project.slug}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EndpointDocs({
  endpoints,
  onTry,
}: {
  endpoints: EndpointRow[];
  onTry: (endpointId: string) => void;
}) {
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
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">API reference</h2>
        <p className="text-sm text-muted-foreground">
          Parameters, examples, responses, and exact live cost come from this
          immutable published OpenAPI version.
        </p>
      </div>
      <div className="space-y-4">
        {endpoints.map((ep) => (
          <Card key={ep.id} id={`operation-${encodeURIComponent(ep.id)}`}>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <MethodBadge method={ep.method} />
                    <code className="min-w-0 break-all text-sm">{ep.path}</code>
                  </div>
                  <CardTitle className="text-base">
                    {ep.summary ?? ep.operationId ?? "Untitled operation"}
                  </CardTitle>
                  {ep.description ? (
                    <CardDescription className="max-w-3xl whitespace-pre-wrap">
                      {ep.description}
                    </CardDescription>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="tabular-nums">
                    Live · {creditsLabel(ep.cost)}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onTry(ep.id)}
                  >
                    Try mock
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">Mock · 0 credits</Badge>
                {ep.freeTier !== undefined ? (
                  <Badge variant="outline">
                    {ep.freeTier} free live calls/day
                  </Badge>
                ) : null}
                {ep.operationId ? (
                  <Badge variant="outline">
                    <code>{ep.operationId}</code>
                  </Badge>
                ) : null}
                {ep.tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>

              <ReferenceParameters parameters={ep.parameters} />

              {ep.requestBodyDeclared ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">
                    Request body{ep.requestBodyRequired ? " · required" : ""}
                  </h3>
                  <p className="font-mono text-xs text-muted-foreground">
                    {ep.requestContentType}
                  </p>
                  <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
                    <SyntaxCode
                      code={ep.requestBodyExample}
                      lang={
                        ep.requestContentType.includes("json")
                          ? "json"
                          : "plain"
                      }
                    />
                  </pre>
                </div>
              ) : null}

              <ReferenceResponses responses={ep.responses} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ReferenceParameters({ parameters }: { parameters: ApiParameter[] }) {
  if (parameters.length === 0) {
    return (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Parameters</h3>
        <p className="text-sm text-muted-foreground">No parameters declared.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Parameters</h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                In
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Type
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {parameters.map((parameter) => (
              <tr key={parameter.key} className="border-b last:border-0">
                <th
                  scope="row"
                  className="px-3 py-2 font-mono text-xs font-medium"
                >
                  {parameter.name}
                  {parameter.required ? (
                    <span
                      className="ml-1 text-destructive"
                      aria-label="required"
                    >
                      *
                    </span>
                  ) : null}
                </th>
                <td className="px-3 py-2 text-muted-foreground">
                  {parameter.location}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {parameter.type}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {parameter.description ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReferenceResponses({
  responses,
}: {
  responses: ApiEndpoint["responses"];
}) {
  if (responses.length === 0) {
    return (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Responses</h3>
        <p className="text-sm text-muted-foreground">No responses declared.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Responses</h3>
      <div className="divide-y rounded-md border">
        {responses.map((response) => (
          <details key={response.status} className="group px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-sm text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Badge variant="outline" className="tabular-nums">
                {response.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                {response.description ?? "No description"}
              </span>
              <span className="text-xs text-muted-foreground group-open:hidden">
                View
              </span>
              <span className="hidden text-xs text-muted-foreground group-open:inline">
                Hide
              </span>
            </summary>
            <div className="space-y-2 pt-3">
              <p className="font-mono text-xs text-muted-foreground">
                {response.contentTypes.join(", ") || "No response media type"}
              </p>
              {response.example ? (
                <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
                  <SyntaxCode
                    code={response.example}
                    lang={
                      response.contentTypes.some((type) =>
                        type.includes("json"),
                      )
                        ? "json"
                        : "plain"
                    }
                  />
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No response example declared.
                </p>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
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
  publisherHandle,
  projectSlug,
  endpoints,
  endpointId,
  mode,
  onEndpointChange,
  onModeChange,
}: {
  publisherHandle: string;
  projectSlug: string;
  endpoints: EndpointRow[];
  endpointId: string;
  mode: PlaygroundMode;
  onEndpointChange: (endpointId: string) => void;
  onModeChange: (mode: PlaygroundMode) => void;
}) {
  const { userId } = Route.useRouteContext();
  const endpoint =
    endpoints.find((e) => e.id === endpointId) ?? endpoints[0] ?? null;

  const [parameterValues, setParameterValues] = useState<
    Record<string, string>
  >({});
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState(
    endpoint?.requestBodyExample ?? "{\n  \n}",
  );
  const [apiKey, setApiKey] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const mock = mode === "mock";

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(API_KEY_STORAGE);
      if (stored && stored.length <= 4096) setApiKey(stored);
    } catch {
      // sessionStorage may be blocked
    }
  }, []);

  useEffect(() => {
    if (!endpoint) return;
    setParameterValues((previous) => {
      const next: Record<string, string> = {};
      for (const parameter of endpoint.parameters) {
        next[parameter.key] = previous[parameter.key] ?? parameter.initialValue;
      }
      return next;
    });
    setBodyText(endpoint.requestBodyExample);
    setErrors({});
    setResult(null);
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
    const path = buildRequestPath(endpoint.path, parameterValues);
    const base = tryItBaseUrl(gatewayBaseUrl(), mock);
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return appendQueryParameters(
      `${base}/${publisherHandle}/${projectSlug}${suffix}`,
      endpoint.parameters,
      parameterValues,
    );
  }, [endpoint, parameterValues, publisherHandle, projectSlug, mock]);

  const returnPath = useMemo(() => {
    const search = new URLSearchParams({
      tab: "try",
      mode,
      ...(endpoint ? { operation: endpoint.id } : {}),
    });
    return `/catalogue/${encodeURIComponent(publisherHandle)}/${encodeURIComponent(projectSlug)}?${search.toString()}`;
  }, [endpoint, mode, projectSlug, publisherHandle]);

  const needsBody =
    endpoint !== null &&
    endpoint.requestBodyDeclared &&
    (endpoint.method === "post" ||
      endpoint.method === "put" ||
      endpoint.method === "patch");

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!endpoint || sending) return;
    const nextErrors: Record<string, string> = {};
    for (const parameter of endpoint.parameters) {
      if (
        parameter.required &&
        (parameterValues[parameter.key]?.trim() ?? "") === ""
      ) {
        nextErrors[parameter.key] = `${parameter.name} is required.`;
      }
    }
    if (invalidHeaderLine(headersText)) {
      nextErrors.headers = "Each header must use the format Name: value.";
    }
    if (!mock && apiKey.trim() === "") {
      nextErrors.apiKey = "API key is required for a live call.";
    }
    if (needsBody && endpoint.requestBodyRequired && bodyText.trim() === "") {
      nextErrors.body = "Request body is required.";
    } else if (
      needsBody &&
      bodyText.trim() !== "" &&
      endpoint.requestContentType.toLowerCase().includes("json")
    ) {
      try {
        JSON.parse(bodyText);
      } catch {
        nextErrors.body = "Body must be valid JSON.";
      }
    }
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0];
    if (firstError !== undefined) {
      const parameter = endpoint.parameters.find(
        (candidate) => candidate.key === firstError,
      );
      const targetId = parameter
        ? parameterInputId(endpoint.id, parameter)
        : firstError === "apiKey"
          ? "api-key"
          : firstError === "body"
            ? "try-body"
            : "try-headers";
      document.getElementById(targetId)?.focus();
      return;
    }

    const headers = parseExtraHeaders(headersText);
    for (const parameter of endpoint.parameters) {
      if (parameter.location !== "header") continue;
      const value = parameterValues[parameter.key]?.trim() ?? "";
      if (value !== "") headers[parameter.name] = value;
    }
    const key = apiKey.trim();
    if (!mock) {
      headers.Authorization = `Bearer ${key}`;
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
        headers["Content-Type"] = endpoint.requestContentType;
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
        contentType: res.headers.get("content-type"),
        requestId: res.headers.get("x-zevium-request-id") ?? undefined,
      });
    } catch {
      const ms = Math.round(performance.now() - t0);
      setResult({
        status: 0,
        statusText: "Network error",
        ms,
        body: "The browser could not reach the gateway.",
        mock,
        contentType: null,
      });
    } finally {
      setSending(false);
    }
  }

  function onCopyCurl() {
    if (!endpoint) return;
    const headers = parseExtraHeaders(headersText);
    for (const parameter of endpoint.parameters) {
      if (parameter.location !== "header") continue;
      const value = parameterValues[parameter.key]?.trim() ?? "";
      if (value !== "") headers[parameter.name] = value;
    }
    if (!mock) headers.Authorization = "Bearer YOUR_API_KEY";
    let body: string | undefined;
    if (needsBody && bodyText.trim().length > 0) {
      body = bodyText;
      if (
        headers["Content-Type"] === undefined &&
        headers["content-type"] === undefined
      ) {
        headers["Content-Type"] = endpoint.requestContentType;
      }
    }
    const curl = buildCurl({
      method: endpoint.method,
      url: requestUrl,
      headers,
      body,
    });
    void copyText(curl).then((copied) => {
      setCopyState(copied ? "copied" : "error");
      if (copied) window.setTimeout(() => setCopyState("idle"), 1500);
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

  const readableResultBody = result
    ? result.status >= 400
      ? sanitizedGatewayErrorResponse(
          result.body,
          result.contentType,
          result.requestId,
        )
      : readableJsonResponse(result.body, result.contentType)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Request playground</CardTitle>
        <CardDescription>
          Mock is default: schema-generated response, no key, no upstream, zero
          credits. Switch to live only when ready to spend.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={onSend}>
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel id="playground-mode-label">Environment</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={mode}
                onValueChange={(value) => {
                  if (value === "mock" || value === "live") {
                    onModeChange(value);
                  }
                }}
                aria-labelledby="playground-mode-label"
              >
                <ToggleGroupItem value="mock">Mock · 0 credits</ToggleGroupItem>
                <ToggleGroupItem value="live">
                  Live · {liveCostLabel(endpoint)}
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>

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
              Live call · published price {creditsLabel(endpoint?.cost ?? 0)}.
              {endpoint?.freeTier !== undefined
                ? ` First ${endpoint.freeTier} eligible calls per day cost 0; remaining allowance is unavailable in this view.`
                : ""}{" "}
              Zero balance blocks paid execution. Key stays in this browser tab.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="try-endpoint">Operation</FieldLabel>
              <Select
                value={endpoint?.id ?? ""}
                onValueChange={onEndpointChange}
              >
                <SelectTrigger id="try-endpoint" className="w-full font-mono">
                  <SelectValue placeholder="Select operation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {endpoints.map((ep) => (
                      <SelectItem key={ep.id} value={ep.id}>
                        {ep.method.toUpperCase()} {ep.path} ·{" "}
                        {creditsLabel(ep.cost)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Selection is stored in URL so this exact operation is shareable.
              </FieldDescription>
            </Field>

            {endpoint?.parameters.map((parameter) => {
              const inputId = parameterInputId(endpoint.id, parameter);
              const error = errors[parameter.key];
              const descriptionId = `${inputId}-description`;
              const errorId = `${inputId}-error`;
              return (
                <Field key={parameter.key} data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor={inputId}>
                    {parameter.name}
                    <span className="font-normal text-muted-foreground">
                      {parameter.location}
                      {parameter.required ? " · required" : ""}
                    </span>
                  </FieldLabel>
                  <Input
                    id={inputId}
                    name={parameter.key}
                    value={parameterValues[parameter.key] ?? ""}
                    onChange={(event) => {
                      setParameterValues((previous) => ({
                        ...previous,
                        [parameter.key]: event.target.value,
                      }));
                      if (error) {
                        setErrors((previous) => {
                          const next = { ...previous };
                          delete next[parameter.key];
                          return next;
                        });
                      }
                    }}
                    placeholder={`${parameter.type} value`}
                    className="font-mono text-sm"
                    aria-invalid={Boolean(error)}
                    aria-describedby={
                      [
                        parameter.description ? descriptionId : null,
                        error ? errorId : null,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  />
                  {parameter.description ? (
                    <FieldDescription id={descriptionId}>
                      {parameter.description}
                    </FieldDescription>
                  ) : null}
                  <FieldError id={errorId}>{error}</FieldError>
                </Field>
              );
            })}

            {!mock ? (
              <Field
                className="sm:col-span-2"
                data-invalid={Boolean(errors.apiKey)}
              >
                <FieldLabel htmlFor="api-key">API key</FieldLabel>
                <Input
                  id="api-key"
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  spellCheck={false}
                  placeholder="zv_…"
                  value={apiKey}
                  onChange={(e) => {
                    onApiKeyChange(e.target.value);
                    if (errors.apiKey) {
                      setErrors((previous) => {
                        const next = { ...previous };
                        delete next.apiKey;
                        return next;
                      });
                    }
                  }}
                  className="font-mono text-sm"
                  aria-invalid={Boolean(errors.apiKey)}
                  aria-describedby="api-key-help"
                />
                <FieldDescription id="api-key-help">
                  Stored in this browser session only. Never sent to Convex. Use
                  the canonical <code>Authorization: Bearer</code> header.
                </FieldDescription>
                <FieldError>{errors.apiKey}</FieldError>
                <p className="text-xs text-muted-foreground">
                  {userId ? (
                    <Link
                      to="/app/settings/keys"
                      search={{ returnTo: returnPath }}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Manage keys →
                    </Link>
                  ) : (
                    <Link
                      to="/sign-up/$"
                      search={{ redirect: returnPath }}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Create account, then a key →
                    </Link>
                  )}
                </p>
              </Field>
            ) : null}

            <Field
              className="sm:col-span-2"
              data-invalid={Boolean(errors.headers)}
            >
              <FieldLabel htmlFor="try-headers">Additional headers</FieldLabel>
              <Textarea
                id="try-headers"
                name="headers"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.headers)}
                aria-describedby="try-headers-help"
                value={headersText}
                onChange={(e) => {
                  setHeadersText(e.target.value);
                  if (errors.headers) {
                    setErrors((previous) => {
                      const next = { ...previous };
                      delete next.headers;
                      return next;
                    });
                  }
                }}
                placeholder={"Accept: application/json"}
                rows={3}
                className="min-h-24 font-mono text-xs"
              />
              <FieldDescription id="try-headers-help">
                One <code>Name: value</code> pair per line. Declared header
                parameters have dedicated fields above.
              </FieldDescription>
              <FieldError>{errors.headers}</FieldError>
            </Field>

            {needsBody ? (
              <Field
                className="sm:col-span-2"
                data-invalid={Boolean(errors.body)}
              >
                <FieldLabel htmlFor="try-body">
                  Request body
                  <span className="font-normal text-muted-foreground">
                    {endpoint?.requestContentType}
                    {endpoint?.requestBodyRequired ? " · required" : ""}
                  </span>
                </FieldLabel>
                <Textarea
                  id="try-body"
                  name="request-body"
                  autoComplete="off"
                  value={bodyText}
                  onChange={(e) => {
                    setBodyText(e.target.value);
                    if (errors.body) {
                      setErrors((previous) => {
                        const next = { ...previous };
                        delete next.body;
                        return next;
                      });
                    }
                  }}
                  rows={6}
                  spellCheck={false}
                  className="min-h-24 font-mono text-xs"
                  aria-invalid={Boolean(errors.body)}
                  aria-describedby="try-body-help"
                />
                <FieldDescription id="try-body-help">
                  Seeded from examples or schema defaults in the published spec.
                </FieldDescription>
                <FieldError>{errors.body}</FieldError>
              </Field>
            ) : null}
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">Request URL</p>
            <p className="mt-1 break-all font-mono text-xs">{requestUrl}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={sending || !endpoint}>
              {sending
                ? "Sending…"
                : mock
                  ? "Send mock · 0 credits"
                  : `Send live · ${liveCostLabel(endpoint)}`}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onCopyCurl()}
              disabled={!endpoint}
            >
              {copyState === "copied" ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {copyState === "copied" ? "Copied curl" : "Copy curl"}
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {copyState === "error"
                ? "Copy failed. Select request values and copy manually."
                : mock
                  ? "Generated curl uses the keyless mock endpoint."
                  : "Generated curl uses a placeholder and never copies your secret."}
            </span>
          </div>

          {result ? (
            <div className="space-y-2" role="status" aria-live="polite">
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
                {result.requestId ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    Request {result.requestId}
                  </span>
                ) : null}
              </div>
              {result.status === 0 ? (
                <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  <p className="font-medium text-destructive">
                    Gateway could not be reached
                  </p>
                  <p className="text-muted-foreground">
                    Check your connection and gateway URL. If this persists,
                    allow this site in gateway CORS settings, then retry.
                  </p>
                </div>
              ) : result.status >= 400 ? (
                <p className="text-sm text-muted-foreground">
                  {result.status === 401
                    ? "Your API key was not accepted. Create or rotate a key, then try again."
                    : result.status === 402
                      ? "Your organization needs credits before this call can run."
                      : result.status === 429
                        ? "This key reached a limit. Wait or adjust its cap."
                        : result.status >= 500
                          ? "The upstream service failed. Retry later."
                          : "Check the request fields and try again."}
                </p>
              ) : null}
              {result.status > 0 && readableResultBody !== null ? (
                <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                  <SyntaxCode
                    code={readableResultBody ?? (result.body || "(empty body)")}
                    lang={
                      readableResultBody !== null
                        ? "json"
                        : responseLanguage(result.body)
                    }
                  />
                </pre>
              ) : result.status > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Response body is hidden because it is not a verified Zevium
                  error envelope. Use request ID above when contacting support.
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void copyText(text).then((copied) => {
            setState(copied ? "copied" : "error");
            if (copied) window.setTimeout(() => setState("idle"), 1500);
          });
        }}
      >
        {state === "copied" ? <Check /> : <Copy />}
        {state === "copied" ? "Copied" : label}
      </Button>
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {state === "error" ? "Copy failed. Select and copy manually." : ""}
      </span>
    </div>
  );
}

function ConnectAgentPanel({
  publisherHandle,
  projectSlug,
}: {
  publisherHandle: string;
  projectSlug: string;
}) {
  const gatewayOrigin = resolveGatewayOrigin(
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
  );
  const mcpUrl = mcpEndpointUrl(gatewayOrigin);
  const snippet = buildMcpConfigSnippet(mcpUrl);

  const notes = `// Agent notes for ${publisherHandle}/${projectSlug}
// 1. Search catalogue with tool search_apis({ query })
// 2. Load docs with get_api_docs({ org: "${publisherHandle}", project: "${projectSlug}" })
// 3. Call via call_api — same key-authenticated, credit-gated gateway as humans
// Gateway base: ${gatewayBaseUrl()}/${publisherHandle}/${projectSlug}`;

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
            <SyntaxCode code={snippet} lang="json" />
          </pre>
          <CopyAction text={snippet} label="Copy config" />
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
            <SyntaxCode code={notes} lang="js" />
          </pre>
          <CopyAction text={notes} label="Copy notes" />
        </CardContent>
      </Card>
    </div>
  );
}

function ApiNotFound() {
  return (
    <Empty className="min-h-80 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageX />
        </EmptyMedia>
        <EmptyTitle>API not found</EmptyTitle>
        <EmptyDescription>
          This listing is missing, private, or unpublished. Browse the public
          catalogue for live APIs.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/catalogue">Back to catalogue</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ApiDetailBodySkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
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
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-8 outline-none"
      >
        <ApiDetailBodySkeleton />
      </main>
    </div>
  );
}
