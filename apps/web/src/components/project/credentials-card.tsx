import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import type { Doc, Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { formatRelativeTime } from "#/lib/relative-time";
import {
  SettingsCardSkeleton,
  SettingsQueryErrorCard,
} from "./settings-query-state";
export function UpstreamCredentialsCard({
  project,
}: {
  project: Doc<"projects">;
}) {
  const credentialsQuery = useQuery(
    convexQuery(api.upstreamCredentials.listForProject, {
      projectId: project._id,
    }),
  );
  const upsertCredential = useConvexMutation(api.upstreamCredentials.upsert);
  const removeCredential = useConvexMutation(api.upstreamCredentials.remove);

  const [name, setName] = useState("x-api-key");
  const [secret, setSecret] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialToRemove, setCredentialToRemove] = useState<{
    id: Id<"upstreamCredentials">;
    name: string;
  } | null>(null);
  const { mutate: saveCredential, isPending: saving } = useMutation({
    mutationFn: async (input: { name: string; secret: string }) => ({
      projectId: project._id,
      result: await upsertCredential({
        projectId: project._id,
        name: input.name,
        secret: input.secret,
      }),
    }),
    onSuccess: () => {
      setSecret("");
      setRevealSecret(false);
    },
    onError: (err: unknown) => {
      setCredentialError(humanError(err, "Could not save upstream credential"));
      document.getElementById("upstream-header-secret")?.focus();
    },
  });

  const { mutate: deleteCredential, isPending: deleting } = useMutation({
    mutationFn: async (credentialId: Id<"upstreamCredentials">) => ({
      projectId: project._id,
      result: await removeCredential({ credentialId }),
    }),
    onSuccess: () => {
      setCredentialToRemove(null);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not remove upstream credential"));
    },
  });

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (name.trim() === "" || secret.trim() === "") {
      setCredentialError("Enter both a header name and secret value.");
      document
        .getElementById(
          name.trim() === ""
            ? "upstream-header-name"
            : "upstream-header-secret",
        )
        ?.focus();
      return;
    }
    setCredentialError(null);
    saveCredential({ name: name.trim(), secret });
  }

  const credentials = credentialsQuery.data ?? [];

  if (credentialsQuery.isPending) {
    return (
      <SettingsCardSkeleton
        title="Upstream credentials"
        description="Loading encrypted header configuration."
      />
    );
  }

  if (credentialsQuery.isError) {
    return (
      <SettingsQueryErrorCard
        title="Upstream credentials unavailable"
        message={humanError(
          credentialsQuery.error,
          "Could not load upstream credentials.",
        )}
        onRetry={() => void credentialsQuery.refetch()}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle
          role="heading"
          aria-level={2}
          className="flex items-center gap-2"
        >
          <KeyRound className="size-4 text-muted-foreground" />
          Upstream credentials
        </CardTitle>
        <CardDescription>
          The gateway uses these headers to authenticate with your API. Consumer
          keys are removed before forwarding. Save secrets carefully; their
          values cannot be shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={onSave}
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="upstream-header-name">Header name</Label>
            <Input
              id="upstream-header-name"
              name="upstream-header-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setCredentialError(null);
              }}
              placeholder="x-api-key"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              required
              aria-invalid={credentialError !== null && name.trim() === ""}
              aria-describedby={
                credentialError ? "upstream-credential-error" : undefined
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="upstream-header-secret">Secret value</Label>
            <div className="relative">
              <Input
                id="upstream-header-secret"
                name="upstream-header-secret"
                type={revealSecret ? "text" : "password"}
                value={secret}
                aria-invalid={credentialError !== null && secret.trim() === ""}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setCredentialError(null);
                }}
                placeholder="Enter new value"
                autoComplete="new-password"
                disabled={saving}
                required
                className="pr-10"
                aria-describedby={
                  credentialError ? "upstream-credential-error" : undefined
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setRevealSecret((value) => !value)}
                aria-label={
                  revealSecret ? "Hide secret value" : "Show secret value"
                }
                disabled={saving}
              >
                {revealSecret ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </div>
          <Button type="submit" className="self-end" disabled={saving}>
            {saving ? "Saving…" : "Save credential"}
          </Button>
          <p
            id="upstream-credential-error"
            role={credentialError ? "alert" : undefined}
            className={`min-h-5 text-xs sm:col-span-3 ${credentialError ? "text-destructive" : "text-muted-foreground"}`}
          >
            {credentialError ??
              "Header names are case-insensitive. Secret values are write-only."}
          </p>
        </form>

        {credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upstream credentials configured.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {credentials.map((credential) => (
              <div
                key={credential.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">
                    {credential.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Updated {formatRelativeTime(credential.updatedAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${credential.name}`}
                  onClick={() =>
                    setCredentialToRemove({
                      id: credential.id,
                      name: credential.name,
                    })
                  }
                  disabled={deleting}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <Dialog
        open={credentialToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setCredentialToRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove {credentialToRemove?.name ?? "credential"}?
            </DialogTitle>
            <DialogDescription>
              Replace this credential first if your API still requires it. Live
              calls may fail once its removal reaches the gateway.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCredentialToRemove(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (credentialToRemove) deleteCredential(credentialToRemove.id);
              }}
              disabled={deleting}
            >
              {deleting ? "Removing…" : "Remove credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Webhooks — endpoint config + recent deliveries.
// Endpoint reads contain metadata only. Admins explicitly decrypt the signing
// secret on demand; hiding it drops the plaintext from component state.
// ---------------------------------------------------------------------------
