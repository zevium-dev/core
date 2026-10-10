import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, Webhook } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

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
import { Switch } from "#/components/ui/switch";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import {
  SettingsCardSkeleton,
  SettingsQueryErrorCard,
} from "./settings-query-state";
import { WebhookDeliveries } from "./webhook-deliveries";
export function WebhooksCard({ project }: { project: Doc<"projects"> }) {
  const endpointQuery = useQuery(
    convexQuery(api.webhooks.getEndpoint, { projectId: project._id }),
  );

  const endpoint = endpointQuery.data ?? null;
  const [urlEdit, setUrl] = useState<string | undefined>();
  const url = urlEdit ?? endpoint?.url ?? "";
  const [activeEdit, setActive] = useState<boolean | undefined>();
  const active = activeEdit ?? endpoint?.active ?? true;
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const revealedSecretVersionRef = useRef<number | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  // Revoke a displayed secret only when a newer version supersedes it.
  useEffect(() => {
    if (endpoint !== null) {
      // A rotation response is the only reveal of its version. Its realtime
      // metadata update must not erase that response before it can be copied.
      const revealedVersion = revealedSecretVersionRef.current;
      if (
        revealedVersion !== null &&
        endpoint.secretVersion > revealedVersion
      ) {
        revealedSecretVersionRef.current = null;
        setRevealedSecret(null);
        setCopiedSecret(false);
      }
    } else if (endpointQuery.isSuccess) {
      revealedSecretVersionRef.current = null;
      setRevealedSecret(null);
      setCopiedSecret(false);
    }
  }, [endpoint, endpointQuery.isSuccess, project._id]);

  const upsertMut = useConvexMutation(api.webhooks.upsertEndpoint);
  const revealMut = useConvexMutation(api.webhooks.revealSecret);
  const rotateMut = useConvexMutation(api.webhooks.rotateSecret);

  const revealMutation = useMutation({
    mutationFn: () => revealMut({ projectId: project._id }),
    onSuccess: (result) => {
      if (result === null) {
        toast.error("Secret was already revealed. Rotate it to get a new one.");
        return;
      }
      revealedSecretVersionRef.current = endpoint?.secretVersion ?? null;
      setRevealedSecret(result.secret);
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not reveal signing secret")),
  });

  const rotateMutation = useMutation({
    mutationFn: () =>
      rotateMut({ projectId: project._id, graceSeconds: 60 * 60 }),
    onSuccess: (result) => {
      revealedSecretVersionRef.current = result.secretVersion;
      setRevealedSecret(result.secret);
      setCopiedSecret(false);
      revealMutation.reset();
      toast.success("Signing secret rotated; prior version works for 1 hour");
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not rotate signing secret")),
  });

  const { mutate: saveEndpoint, isPending: saving } = useMutation({
    mutationFn: async (input: { url: string; active: boolean }) => ({
      projectId: project._id,
      result: await upsertMut({
        projectId: project._id,
        url: input.url,
        active: input.active,
      }),
    }),
    onSuccess: () => {
      setWebhookError(null);
      setUrl(undefined);
      setActive(undefined);
    },
    onError: (err: unknown) => {
      setWebhookError(humanError(err, "Could not save webhook endpoint"));
      document.getElementById("webhook-url")?.focus();
    },
  });

  const trimmedUrl = url.trim();
  const urlValid = isValidWebhookUrl(trimmedUrl);
  const dirty =
    endpoint === null
      ? trimmedUrl.length > 0
      : trimmedUrl !== endpoint.url || active !== endpoint.active;

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!urlValid) {
      setWebhookError(
        trimmedUrl === ""
          ? "Enter a webhook endpoint URL."
          : "Enter a public HTTPS URL without credentials. Localhost is not supported.",
      );
      document.getElementById("webhook-url")?.focus();
      return;
    }
    setWebhookError(null);
    saveEndpoint({ url: trimmedUrl, active });
  }

  async function copySecret() {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      setCopiedSecret(true);
      setTimeout(() => {
        setCopiedSecret(false);
      }, 1500);
    } catch {
      toast.error("Could not copy secret");
    }
  }

  if (endpointQuery.isPending) {
    return (
      <SettingsCardSkeleton
        title="Webhooks"
        description="Loading endpoint and signing-secret state."
      />
    );
  }

  if (endpointQuery.isError) {
    return (
      <SettingsQueryErrorCard
        title="Webhooks unavailable"
        message={humanError(
          endpointQuery.error,
          "Could not load webhook configuration.",
        )}
        onRetry={() => void endpointQuery.refetch()}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Webhook className="size-4 text-muted-foreground" />
          Webhooks
        </CardTitle>
        <CardDescription>
          Receive events when a version is published or deprecated, or when
          project visibility changes. Each project can have one webhook
          endpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={onSave} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <Input
              id="webhook-url"
              name="webhook-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setWebhookError(null);
              }}
              placeholder="https://example.com/hooks/zevium"
              className="font-mono text-sm"
              disabled={saving}
              spellCheck={false}
              autoComplete="url"
              aria-invalid={webhookError !== null}
              aria-describedby="webhook-url-help"
            />

            <p
              id="webhook-url-help"
              role={webhookError ? "alert" : undefined}
              className={`min-h-5 text-xs ${webhookError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {webhookError ??
                "Use a public HTTPS URL without credentials. Localhost is not supported."}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="webhook-secret">Signing secret</Label>
            {endpoint !== null ? (
              <div className="flex items-center gap-2">
                <Input
                  id="webhook-secret"
                  readOnly
                  value={
                    revealMutation.isPending
                      ? "Decrypting…"
                      : (revealedSecret ?? "••••••••••••••••••••••••••••••••")
                  }
                  className="font-mono text-sm"
                  aria-label="Webhook signing secret"
                  aria-busy={revealMutation.isPending}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    if (revealedSecret !== null) {
                      revealedSecretVersionRef.current = null;
                      setRevealedSecret(null);
                      setCopiedSecret(false);
                      revealMutation.reset();
                      return;
                    }
                    revealMutation.mutate();
                  }}
                  disabled={revealMutation.isPending}
                  aria-label={
                    revealedSecret !== null ? "Hide secret" : "Reveal secret"
                  }
                >
                  {revealedSecret !== null ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copySecret}
                  disabled={revealedSecret === null}
                  aria-label="Copy secret"
                >
                  {copiedSecret ? (
                    <Check className="size-4 text-success-foreground" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => rotateMutation.mutate()}
                  disabled={rotateMutation.isPending}
                >
                  {rotateMutation.isPending ? "Rotating…" : "Rotate"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Save an endpoint to generate a signing secret.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="webhook-active" className="text-sm">
                Active
              </Label>
              <p className="text-xs text-muted-foreground">
                Inactive endpoints skip delivery entirely.
              </p>
            </div>
            <Switch
              id="webhook-active"
              checked={active}
              onCheckedChange={setActive}
              disabled={saving}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !dirty}>
              {saving
                ? "Saving…"
                : endpoint === null
                  ? "Create endpoint"
                  : "Save changes"}
            </Button>
          </div>
        </form>

        <WebhookDeliveries project={project} hasEndpoint={endpoint !== null} />
      </CardContent>
    </Card>
  );
}

/** Mirrors the public HTTPS requirements in validateWebhookUrl. */
function isValidWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") &&
    !hostname.endsWith(".internal")
  );
}
