import {
  CALL_API_WRITE,
  callApiTool,
  serializeRequestParameters,
  tryItBaseUrl,
  type RequestParameter,
  validateFormValue,
} from "@zevium/shared";
import { SchemaField, SchemaBody } from "#/components/schema-form";
import { CopyButton } from "#/components/copy-button";
import { formatDate } from "#/lib/format";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "#/components/ui/table";
import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useHydrated } from "@tanstack/react-router";
import { PackageX, TriangleAlert } from "lucide-react";
import {
  Suspense,
  useCallback,
  useSyncExternalStore,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { AgentInstall } from "#/components/agent-install";
import { DocsCodeBlock } from "#/components/docs-code-block";
import {
  CatalogueShell,
  useCatalogueLinks,
} from "#/components/catalogue-shell";
import { QualityBadges } from "#/components/quality-badges";
import { ReviewSection } from "#/components/review-section";
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
import type { ApiDetailSearch } from "#/lib/catalogue-detail-search";
import { creditsLabel } from "#/lib/credits-label";
import { resolveGatewayOrigin } from "#/lib/landing";
import {
  parsePublishedEndpoints,
  readableSuccessResponse,
  sanitizedGatewayErrorResponse,
  type ApiEndpoint,
  type ApiParameter,
} from "#/lib/openapi-reference";

const API_KEY_STORAGE = "zevium:playground-api-key";
const DEFAULT_GATEWAY = "http://localhost:8787/gateway";

function responseLanguage(body: string): "json" | "plain" {
  try {
    JSON.parse(body);
    return "json";
  } catch {
    return "plain";
  }
}

type EndpointRow = ApiEndpoint;
type ApiDetailTab = ApiDetailSearch["tab"];
type PlaygroundMode = ApiDetailSearch["mode"];

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
  const headers = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key.length > 0) headers.set(key, value);
  }
  return Object.fromEntries(headers);
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

function liveCostLabel(endpoint: EndpointRow | null): string {
  if (endpoint === null) return "cost unavailable";
  if (endpoint.freeTier !== undefined) {
    return `up to ${creditsLabel(endpoint.cost)}`;
  }
  return creditsLabel(endpoint.cost);
}

type ApiDetailProps = {
  publisherHandle: string;
  projectSlug: string;
  routeSearch: ApiDetailSearch;
  onSearchChange: (search: ApiDetailSearch, replace?: boolean) => void;
  userId: string | null;
};

export function CatalogueDetail({
  inApp = false,
  ...props
}: ApiDetailProps & { inApp?: boolean }) {
  return (
    <CatalogueShell inApp={inApp}>
      <Suspense fallback={<ApiDetailBodySkeleton />}>
        <ApiDetailBody {...props} />
      </Suspense>
    </CatalogueShell>
  );
}

function ApiDetailBody({
  publisherHandle,
  projectSlug,
  routeSearch,
  onSearchChange,
  userId,
}: ApiDetailProps) {
  const links = useCatalogueLinks();
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.getPublicDetail, {
      publisherHandle,
      projectSlug,
    }),
  );

  const spec = data?.latestVersion?.spec;
  const endpoints = useMemo(() => {
    if (spec === undefined) return [] as EndpointRow[];
    try {
      return parsePublishedEndpoints(spec);
    } catch {
      return [] as EndpointRow[];
    }
  }, [spec]);

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
    onSearchChange({ ...routeSearch, tab }, true);
  };

  const setOperation = (operation: string) => {
    onSearchChange({ ...routeSearch, operation }, true);
  };

  const setMode = (mode: PlaygroundMode) => {
    onSearchChange({ ...routeSearch, mode }, true);
  };

  if (data === null) {
    return <ApiNotFound />;
  }

  return (
    <div
      data-transition-surface={`api-surface-${data.org.publisherHandle}/${data.project.slug}`}
      className="flex flex-col gap-8"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-muted-foreground">
              <Link
                to={links.catalogue}
                className="hover:text-foreground link-draw"
              >
                Catalogue
              </Link>
              <span className="mx-1.5 text-muted-foreground/60">/</span>
              <span className="font-mono text-xs">
                {data.org.publisherHandle}/{data.project.slug}
              </span>
            </p>
            <h1 className="w-fit min-w-0 max-w-full text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {data.project.name}
              {"houseOperated" in data.project &&
                data.project.houseOperated === true && (
                  <Badge variant="secondary">Operated by Zevium</Badge>
                )}
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
                  <span className="inline-block tabular-nums text-foreground">
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
          {endpoints.length > 0 ? (
            <Badge variant="secondary">Agent-ready</Badge>
          ) : null}
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
          Try a free mock to inspect the response shape. Quality badges show
          measured call results and health checks when enough samples are
          available.
        </p>
      </div>

      {data.latestVersion?.deprecatedAt !== undefined ? (
        <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-warning-foreground">
              Deprecated
              {data.latestVersion.sunsetAt !== undefined
                ? ` — sunset ${formatDate(data.latestVersion.sunsetAt)}`
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

      <QualityBadges quality={data.quality} />

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
            userId={userId}
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
              onSearchChange({
                ...routeSearch,
                tab: "try",
                mode: "mock",
                operation,
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

      <ReviewSection projectId={data.project._id} />
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
          Request fields, response examples, and endpoint prices come from the
          published OpenAPI spec.
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
                    Live · {liveCostLabel(ep)}
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
            <CardContent className="flex flex-col gap-5">
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
        <Table className="w-full min-w-[34rem] text-left text-sm">
          <TableHeader className="border-b bg-muted/40 text-xs text-muted-foreground">
            <TableRow>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Name
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                In
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Type
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Description
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parameters.map((parameter) => (
              <TableRow key={parameter.key} className="border-b last:border-0">
                <TableHead
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
                </TableHead>
                <TableCell className="px-3 py-2 text-muted-foreground">
                  {parameter.location}
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs">
                  {parameter.type}
                </TableCell>
                <TableCell className="px-3 py-2 text-muted-foreground">
                  {parameter.description ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

function readStoredApiKey() {
  try {
    const stored = sessionStorage.getItem(API_KEY_STORAGE);
    return stored && stored.length <= 4096 ? stored : "";
  } catch {
    return "";
  }
}
const emptyStoredApiKey = () => "";
function subscribeStoredApiKey(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** call_api_write accepts JSON-serializable bodies; keep non-JSON text verbatim. */
function mcpBody(text: string, contentType: string): unknown {
  if (!contentType.toLowerCase().includes("json")) return text;
  try {
    const value: unknown = JSON.parse(text);
    // call_api_write passes strings through and treats null as absent.
    return typeof value === "string" || value === null ? text : value;
  } catch {
    return text;
  }
}

/** "body/items/0" → "Request body › items › 1"; "query:limit" → "limit (query)". */
function issueLabel(path: string, parameters: RequestParameter[]): string {
  if (path === "apiKey") return "API key";
  if (path === "headers") return "Headers";
  const parameter = parameters.find(
    (p) => path === p.key || path.startsWith(`${p.key}/`),
  );
  const [root = "", ...segments] = path.split("/");
  const head = parameter
    ? `${parameter.name} (${parameter.location})`
    : root === "body"
      ? "Request body"
      : root;
  return [
    head,
    ...segments.map((segment) => {
      const name = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^\d+$/.test(name) ? `item ${Number(name) + 1}` : name;
    }),
  ].join(" › ");
}

function initialBodyText(endpoint: ApiEndpoint): string {
  if (!endpoint.requestContentType.toLowerCase().includes("json"))
    return endpoint.requestBodyExample;
  return endpoint.form.bodyInitial === undefined
    ? ""
    : JSON.stringify(endpoint.form.bodyInitial, null, 2);
}

export function TryItPanel({
  userId,
  publisherHandle,
  projectSlug,
  endpoints,
  endpointId,
  mode,
  onEndpointChange,
  onModeChange,
}: {
  userId: string | null;
  publisherHandle: string;
  projectSlug: string;
  endpoints: EndpointRow[];
  endpointId: string;
  mode: PlaygroundMode;
  onEndpointChange: (endpointId: string) => void;
  onModeChange: (mode: PlaygroundMode) => void;
}) {
  const links = useCatalogueLinks();
  const hydrated = useHydrated();
  const endpoint =
    endpoints.find((e) => e.id === endpointId) ?? endpoints[0] ?? null;

  const [parameterValues, setParameterValues] = useState<
    Record<string, unknown>
  >(() =>
    Object.fromEntries(
      (endpoint?.form.parameters ?? []).map((p) => [p.key, p.initialValue]),
    ),
  );
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState(
    endpoint ? initialBodyText(endpoint) : "",
  );
  const storedApiKey = useSyncExternalStore(
    subscribeStoredApiKey,
    readStoredApiKey,
    emptyStoredApiKey,
  );
  const [apiKeyEdit, setApiKey] = useState<string | null>(null);
  const apiKey = apiKeyEdit ?? storedApiKey;
  const [result, setResult] = useState<PlayResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mock = mode === "mock";

  const [previousEndpoint, setPreviousEndpoint] = useState(endpoint?.id);
  if (previousEndpoint !== endpoint?.id) {
    setPreviousEndpoint(endpoint?.id);
    if (endpoint) {
      setParameterValues(
        Object.fromEntries(
          endpoint.form.parameters.map((p) => [p.key, p.initialValue]),
        ),
      );
      setBodyText(initialBodyText(endpoint));
      setErrors({});
      setResult(null);
    }
  }

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

  const serialized = useMemo(
    () =>
      endpoint
        ? serializeRequestParameters(
            endpoint.path,
            endpoint.form.parameters,
            parameterValues,
          )
        : { path: "", headers: {}, errors: [] },
    [endpoint, parameterValues],
  );
  const requestUrl = `${tryItBaseUrl(gatewayBaseUrl(), mock)}/${publisherHandle}/${projectSlug}${serialized.path}`;

  const returnPath = useMemo(() => {
    const search = new URLSearchParams({
      tab: "try",
      mode,
      ...(endpoint ? { operation: endpoint.id } : {}),
    });
    return `${links.catalogue}/${encodeURIComponent(publisherHandle)}/${encodeURIComponent(projectSlug)}?${search.toString()}`;
  }, [endpoint, mode, projectSlug, publisherHandle, links.catalogue]);

  const needsBody =
    endpoint !== null &&
    endpoint.requestBodyDeclared &&
    endpoint.method !== "get" &&
    endpoint.method !== "head";

  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    const warnings: string[] = [];
    if (!endpoint) return { errors, warnings };
    for (const p of endpoint.form.parameters) {
      const checked = validateFormValue(
        p.schema,
        parameterValues[p.key],
        endpoint.form.document,
        p.required,
        p.key,
      );
      for (const issue of checked.errors) errors[issue.path] = issue.message;
      warnings.push(
        ...checked.warnings.map((issue) => `${p.name}: ${issue.message}`),
      );
    }
    for (const issue of serialized.errors) errors[issue.path] = issue.message;
    if (needsBody) {
      if (!bodyText.trim() && endpoint.requestBodyRequired)
        errors.body = "Request body is required.";
      else if (
        bodyText.trim() &&
        endpoint.requestContentType.toLowerCase().includes("json")
      ) {
        try {
          const checked = validateFormValue(
            endpoint.form.bodySchema,
            JSON.parse(bodyText),
            endpoint.form.document,
            endpoint.requestBodyRequired,
            "body",
          );
          for (const issue of checked.errors)
            errors[issue.path] = issue.message;
          warnings.push(
            ...checked.warnings.map(
              (issue) =>
                `${issueLabel(issue.path, endpoint.form.parameters)}: ${issue.message}`,
            ),
          );
        } catch {
          errors.body = "Body must be valid JSON.";
        }
      }
    }
    return { errors, warnings: [...new Set(warnings)] };
  }, [endpoint, parameterValues, serialized, needsBody, bodyText]);

  function requestHeaders(withKey: boolean) {
    const headers = new Headers(parseExtraHeaders(headersText));
    for (const [name, value] of Object.entries(serialized.headers))
      headers.set(name, value);
    // The gateway credential is owned by the live-call key field, never the spec.
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("payment-signature");
    if (!mock)
      headers.set(
        "Authorization",
        withKey ? `Bearer ${apiKey.trim()}` : "Bearer YOUR_API_KEY",
      );
    if (needsBody && bodyText.trim() && !headers.has("content-type"))
      headers.set("Content-Type", endpoint!.requestContentType);
    return Object.fromEntries(headers.entries());
  }
  let previewHeaders: Record<string, string> = {};
  let headerError = "";
  try {
    previewHeaders = requestHeaders(false);
  } catch {
    headerError = "Enter valid HTTP header names and values.";
  }
  const send = useMutation({
    retry: false,
    mutationFn: async ({
      url,
      init,
      isMock,
    }: {
      url: string;
      init: RequestInit;
      isMock: boolean;
    }): Promise<PlayResult> => {
      const t0 = performance.now();
      try {
        const res = await fetch(url, init);
        const text = await res.text();
        return {
          status: res.status,
          statusText: res.statusText,
          ms: Math.round(performance.now() - t0),
          body: text,
          mock: isMock,
          contentType: res.headers.get("content-type"),
          requestId: res.headers.get("x-zevium-request-id") ?? undefined,
        };
      } catch {
        return {
          status: 0,
          statusText: "Network error",
          ms: Math.round(performance.now() - t0),
          body: "The browser could not reach the gateway.",
          mock: isMock,
          contentType: null,
        };
      }
    },
    onSuccess: setResult,
  });
  const isPending = send.isPending;
  function onSend(e: FormEvent) {
    e.preventDefault();
    if (!hydrated || !endpoint || isPending) return;
    const nextErrors = { ...validation.errors };
    if (invalidHeaderLine(headersText))
      nextErrors.headers = "Each header must use the format Name: value.";
    if (headerError) nextErrors.headers = headerError;
    if (!mock && apiKey.trim() === "")
      nextErrors.apiKey = "API key is required for a live call.";
    let headers: Record<string, string> = {};
    try {
      headers = requestHeaders(true);
    } catch {
      if (!headerError) nextErrors.apiKey = "Enter a valid API key.";
    }
    setErrors(nextErrors);
    const first = Object.keys(nextErrors)[0];
    if (first) {
      const control = Array.from(
        document.querySelectorAll<HTMLElement>("[data-form-path]"),
      ).find((element) => element.dataset.formPath === first);
      (
        control ??
        document.getElementById(
          first === "apiKey"
            ? "api-key"
            : first === "headers"
              ? "try-headers"
              : "try-body",
        )
      )?.focus();
      return;
    }
    setResult(null);
    send.mutate({
      url: requestUrl,
      isMock: mock,
      init: {
        method: endpoint.method.toUpperCase(),
        headers,
        ...(needsBody && bodyText.trim() ? { body: bodyText } : {}),
      },
    });
  }
  function curlText() {
    return endpoint
      ? buildCurl({
          method: endpoint.method,
          url: requestUrl,
          headers: previewHeaders,
          body: needsBody && bodyText.trim() ? bodyText : undefined,
        })
      : "";
  }
  const { authorization: _auth, ...mcpHeaders } = previewHeaders;
  const mcpTool = callApiTool(endpoint?.method ?? "GET") ?? CALL_API_WRITE;
  const mcpText = JSON.stringify(
    {
      org: publisherHandle,
      project: projectSlug,
      method: endpoint?.method.toUpperCase(),
      path: serialized.path,
      headers: mcpHeaders,
      ...(needsBody && bodyText.trim()
        ? { body: mcpBody(bodyText, previewHeaders["content-type"] ?? "") }
        : {}),
    },
    null,
    2,
  );

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
      : readableSuccessResponse(result.body, result.contentType)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Request playground</CardTitle>
        <CardDescription>
          Start with a free mock response generated from the spec. Switch to
          Live to call the publisher’s API at the displayed price.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" noValidate onSubmit={onSend}>
          <fieldset
            disabled={!hydrated || isPending}
            className="flex flex-col gap-5"
          >
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
                  <ToggleGroupItem value="mock">
                    Mock · 0 credits
                  </ToggleGroupItem>
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
                  Calls hit <span className="font-mono text-xs">/mock</span> to
                  return a sample response without contacting the publisher. No
                  key is needed.
                </span>
              </div>
            ) : (
              <div
                role="status"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Live call · published price {liveCostLabel(endpoint ?? null)}.
                {endpoint?.freeTier !== undefined
                  ? ` First ${endpoint.freeTier} eligible calls per day cost 0; remaining allowance is unavailable in this view.`
                  : ""}{" "}
                Live calls require a funded wallet, including endpoints priced
                at zero credits.
              </div>
            )}

            <FieldGroup>
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
                          {liveCostLabel(ep)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Selection is stored in URL so this exact operation is
                  shareable.
                </FieldDescription>
              </Field>

              {endpoint?.form.parameters.map((parameter) => (
                <SchemaField
                  document={endpoint.form.document}
                  key={`${endpoint.id}:${parameter.key}`}
                  node={parameter.node}
                  label={`${parameter.name} (${parameter.location})`}
                  required={parameter.required}
                  path={parameter.key}
                  description={parameter.description}
                  value={parameterValues[parameter.key]}
                  errors={errors}
                  onChange={(value) => {
                    setParameterValues((previous) => ({
                      ...previous,
                      [parameter.key]: value,
                    }));
                    setErrors({});
                  }}
                />
              ))}

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
                    placeholder="ak_…"
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
                    Kept in this browser tab’s session storage and sent to the
                    gateway for live calls using the{" "}
                    <code>Authorization: Bearer</code> header.
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
                <FieldLabel htmlFor="try-headers">
                  Additional headers
                </FieldLabel>
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

              {needsBody && endpoint ? (
                <SchemaBody
                  document={endpoint.form.document}
                  key={endpoint.id}
                  node={endpoint.form.bodyNode}
                  text={bodyText}
                  onChange={(text) => {
                    setBodyText(text);
                    setErrors({});
                  }}
                  errors={errors}
                  required={endpoint.requestBodyRequired}
                  contentType={endpoint.requestContentType}
                />
              ) : null}
            </FieldGroup>
            {Object.keys(errors).length > 0 && (
              <FieldError>
                <ul>
                  {Object.entries(errors).map(([path, message]) => (
                    <li key={path}>
                      {issueLabel(path, endpoint?.form.parameters ?? [])}:{" "}
                      {message}
                    </li>
                  ))}
                </ul>
              </FieldError>
            )}
            {validation.warnings.length > 0 && (
              <FieldDescription>
                Validation is incomplete: {validation.warnings.join(" ")}
              </FieldDescription>
            )}
            <Tabs defaultValue="curl">
              <TabsList aria-label="Request preview">
                <TabsTrigger value="curl">curl</TabsTrigger>
                <TabsTrigger value="mcp">MCP</TabsTrigger>
              </TabsList>
              <TabsContent value="curl">
                <pre
                  className="max-h-80 overflow-auto rounded-md border p-3 text-xs"
                  aria-label="curl preview"
                >
                  {curlText()}
                </pre>
              </TabsContent>
              <TabsContent value="mcp">
                <FieldDescription>
                  Arguments for <code>{mcpTool}</code>, which always makes a
                  live, metered call. Authenticate the MCP connection with OAuth
                  or your Zevium key.{" "}
                  {mock
                    ? "These arguments describe the equivalent live request; MCP has no mock mode."
                    : "Your key is never included in this preview."}
                </FieldDescription>
                <pre
                  className="max-h-80 overflow-auto rounded-md border p-3 text-xs"
                  aria-label="MCP tool arguments"
                >
                  {mcpText}
                </pre>
                <CopyButton text={mcpText} label="Copy MCP arguments" />
              </TabsContent>
            </Tabs>

            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <p className="text-xs text-muted-foreground">Request URL</p>
              <p className="mt-1 break-all font-mono text-xs">{requestUrl}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={isPending || !endpoint}>
                {isPending
                  ? "Sending…"
                  : mock
                    ? "Send mock · 0 credits"
                    : `Send live · ${liveCostLabel(endpoint)}`}
              </Button>
              <CopyButton
                text={curlText}
                label="Copy curl"
                disabled={!endpoint}
              />
              <span
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {mock
                  ? "Generated curl uses the keyless mock endpoint."
                  : "Generated curl uses a placeholder and never copies your secret."}
              </span>
            </div>

            <div className="min-h-[24rem]" role="status" aria-live="polite">
              {isPending ? (
                <div className="space-y-3 rounded-md border p-4">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-72 w-full" />
                </div>
              ) : result ? (
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
                        Check your connection and the request URL, then retry.
                        You can also copy the curl command to try outside the
                        browser.
                      </p>
                    </div>
                  ) : result.status >= 400 ? (
                    <p className="text-sm text-muted-foreground">
                      {result.status === 401
                        ? "Authentication failed. If your Zevium key works with other APIs, contact this publisher."
                        : result.status === 402
                          ? "Check your API key and organization wallet balance, then retry."
                          : result.status === 403
                            ? "Access was denied. Check your API key permissions and status, then retry."
                            : result.status === 429
                              ? "This request was rate-limited. Wait before retrying."
                              : result.status >= 500
                                ? "The gateway or upstream service failed. Retry later."
                                : "Check the request fields and try again."}
                    </p>
                  ) : null}
                  {result.status > 0 && readableResultBody !== null ? (
                    <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                      <SyntaxCode
                        code={readableResultBody}
                        lang={responseLanguage(readableResultBody)}
                      />
                    </pre>
                  ) : result.status >= 400 ? (
                    <p className="text-xs text-muted-foreground">
                      Response details are unavailable. Include the request ID
                      above when contacting support.
                    </p>
                  ) : result.status > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Binary response body is not displayed in the browser.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-80 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  Response appears here after you send the request.
                </div>
              )}
            </div>
          </fieldset>
        </form>
      </CardContent>
    </Card>
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

  const notes = `// Agent notes for ${publisherHandle}/${projectSlug}
// 1. Search catalogue with tool search_apis({ query })
// 2. Load docs with get_api_docs({ org: "${publisherHandle}", project: "${projectSlug}" })
// 3. Call an endpoint with call_api_read (GET/HEAD) or call_api_write (other methods); the connection's OAuth session or key pays from the prepaid wallet
// Gateway base: ${tryItBaseUrl(gatewayBaseUrl(), false)}/${publisherHandle}/${projectSlug}`;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <AgentInstall gatewayOrigin={gatewayOrigin} />

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Usage notes</CardTitle>
          <CardDescription>
            Search for this API, read its reference, then call an endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          <DocsCodeBlock code={notes} lang="js" copyLabel="Copy notes" />
        </CardContent>
      </Card>
    </div>
  );
}

function ApiNotFound() {
  const links = useCatalogueLinks();
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
          <Link to={links.catalogue}>Back to catalogue</Link>
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

export function ApiDetailSkeleton({ inApp = false }: { inApp?: boolean }) {
  return (
    <CatalogueShell inApp={inApp} pending>
      <ApiDetailBodySkeleton />
    </CatalogueShell>
  );
}
