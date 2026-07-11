import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
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
import { Skeleton } from "#/components/ui/skeleton";
import {
  createKey,
  listKeys,
  revokeKey,
  type ApiKeyRow,
  type CreateApiKeyResult,
} from "#/lib/api-keys";
import { humanError } from "#/lib/human-error";
import { DUR, EASE } from "#/lib/motion";

const KEYS_QUERY_KEY = ["settings", "api-keys"] as const;

export const Route = createFileRoute("/app/settings/keys")({
  component: KeysPage,
  head: () => ({
    meta: [{ title: "API keys · Zevium" }],
  }),
});

function KeysPage() {
  const queryClient = useQueryClient();
  const reduce = useReducedMotion();

  const keysQuery = useQuery({
    queryKey: KEYS_QUERY_KEY,
    queryFn: () => listKeys(),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<CreateApiKeyResult | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const createMutation = useMutation({
    mutationFn: (keyName: string) => createKey({ data: { name: keyName } }),
    onSuccess: (result) => {
      setRevealed(result);
      setName("");
      toast.success("API key created — copy it now");
      void queryClient.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not create API key"));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeKey({ data: { id } }),
    onSuccess: () => {
      toast.success("API key revoked");
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not revoke API key"));
    },
  });

  const keys = keysQuery.data ?? [];
  const hasKey = keys.length > 0;
  const isLoading = keysQuery.isPending;

  function closeCreate() {
    if (createMutation.isPending) return;
    setCreateOpen(false);
    setName("");
    setRevealed(null);
    setCopied(false);
  }

  function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (createMutation.isPending || hasKey) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error("Name is required");
      return;
    }
    createMutation.mutate(trimmed);
  }

  async function copySecret() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Machine keys for the gateway. One active key per user.
          </p>
        </div>
        <Button
          onClick={() => {
            setRevealed(null);
            setCopied(false);
            setCreateOpen(true);
          }}
          disabled={hasKey || isLoading}
          title={hasKey ? "Revoke the existing key before creating another" : undefined}
        >
          <Plus className="size-4" />
          Create key
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
          <CardDescription>
            Secrets are shown once at creation. Use the masked id for reference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <KeysTableSkeleton />
          ) : keysQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              {humanError(keysQuery.error, "Could not load keys")}
            </p>
          ) : keys.length === 0 ? (
            <EmptyKeys
              onCreate={() => {
                setRevealed(null);
                setCreateOpen(true);
              }}
            />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="border-b bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Key</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium">Last used</th>
                    <th className="px-3 py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-medium">{key.name}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                        {key.masked}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
                        {formatDate(key.createdAt)}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
                        {key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRevokeTarget(key)}
                          disabled={revokeMutation.isPending}
                        >
                          <Trash2 className="size-4" />
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Prefer account overview?{" "}
        <Link to="/app/settings" className="link-draw text-foreground">
          Back to settings
        </Link>
      </p>

      {/* Create / reveal dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) closeCreate();
          else setCreateOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-md">
          {revealed ? (
            <>
              <DialogHeader>
                <DialogTitle>Copy your key</DialogTitle>
                <DialogDescription>
                  This secret is shown once. Store it somewhere safe — we cannot
                  show it again.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Label>Secret</Label>
                <m.div
                  className="flex items-center gap-2"
                  initial={
                    reduce
                      ? { opacity: 1, filter: "blur(0px)" }
                      : { opacity: 0, filter: "blur(8px)" }
                  }
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  transition={{ duration: DUR.base, ease: EASE }}
                >
                  <code className="block flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs break-all">
                    {revealed.secret}
                  </code>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => void copySecret()}
                    aria-label="Copy secret"
                  >
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </m.div>
              </div>
              <DialogFooter>
                <Button type="button" onClick={closeCreate}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={onCreateSubmit} className="space-y-4">
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  Name the key so you remember where it is used.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Local dev"
                  maxLength={64}
                  autoFocus
                  disabled={createMutation.isPending}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeCreate}
                  disabled={createMutation.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating…" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !revokeMutation.isPending) setRevokeTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke API key?</DialogTitle>
            <DialogDescription>
              {revokeTarget
                ? `“${revokeTarget.name}” stops working immediately. Gateway calls with this key will fail.`
                : "This key will stop working immediately."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={revokeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revokeMutation.isPending || !revokeTarget}
              onClick={() => {
                if (revokeTarget) revokeMutation.mutate(revokeTarget.id);
              }}
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyKeys({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <KeyRound className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No API keys yet</p>
        <p className="text-sm text-muted-foreground">
          Create one key to call the gateway from curl, SDKs, or agents.
        </p>
      </div>
      <Button onClick={onCreate} size="sm">
        <Plus className="size-4" />
        Create key
      </Button>
    </div>
  );
}

function KeysTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-20" />
        </div>
      ))}
    </div>
  );
}

function formatDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
