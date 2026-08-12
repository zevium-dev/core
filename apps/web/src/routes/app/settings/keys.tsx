import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useOrganization } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Check, Copy, KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

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
import { Switch } from "#/components/ui/switch";
import {
  createKey,
  listKeys,
  revokeKey,
  rotateKey,
  type ApiKeyRow,
  type RotateApiKeyResult,
} from "#/lib/api-keys";
import { getApiKeyLifecycle } from "#/lib/api-key-lifecycle";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { parseMonthlyCap } from "#/lib/key-cap";
import { DUR, EASE } from "#/lib/motion";

const KEYS_QUERY_KEY = ["settings", "api-keys"] as const;

/** Secret reveal shape shared by create + rotate. */
type RevealedSecret = {
  id: string;
  name: string;
  secret: string;
  createdAt: number;
  graceUntil?: number;
};

export const Route = createFileRoute("/app/settings/keys")({
  component: KeysPage,
  head: () => ({
    meta: [{ title: "API keys · Zevium" }],
  }),
});

function KeysPage() {
  const { isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthed } =
    useConvexAuth();

  if (!isLoaded || convexAuthLoading) {
    return <KeysSkeleton />;
  }
  if (!convexAuthed) {
    return <KeysSkeleton />;
  }

  return (
    <Suspense fallback={<KeysSkeleton />}>
      <KeysContent />
    </Suspense>
  );
}

function KeysContent() {
  const queryClient = useQueryClient();
  const reduce = useReducedMotion();

  const keysQuery = useQuery({
    queryKey: KEYS_QUERY_KEY,
    queryFn: () => listKeys(),
  });

  // Realtime key-settings (cap, disabled, grace) from the control plane.
  const { data: settingsData } = useSuspenseQuery(
    convexQuery(api.keySettings.getForOrg, {}),
  );
  const settingsByKey = new Map((settingsData ?? []).map((s) => [s.keyId, s]));

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeyRow | null>(null);

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

  const setDisabled = useConvexMutation(api.keySettings.setDisabled);
  const setCap = useConvexMutation(api.keySettings.setCap);
  const rotationOperationIds = useRef(new Map<string, string>());

  const rotateMutation = useMutation({
    mutationFn: (target: ApiKeyRow): Promise<RotateApiKeyResult> => {
      const operationId =
        rotationOperationIds.current.get(target.id) ?? crypto.randomUUID();
      rotationOperationIds.current.set(target.id, operationId);
      return rotateKey({ data: { id: target.id, operationId } });
    },
    onSuccess: (created) => {
      setRevealed(created);
      setRotateTarget(null);
      rotationOperationIds.current.clear();
      toast.success("Key rotated — copy the new secret now");
      void queryClient.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not rotate API key"));
    },
  });

  const keys = keysQuery.data ?? [];
  const hasKey = keys.some(
    (key) =>
      getApiKeyLifecycle(settingsByKey.get(key.id), Date.now()) === "current",
  );
  const isLoading = keysQuery.isPending;

  function closeReveal() {
    if (createMutation.isPending || rotateMutation.isPending) return;
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
          <h2 className="text-lg font-semibold tracking-tight">
            Gateway API keys
          </h2>
          <p className="text-sm text-muted-foreground">
            Machine keys for the gateway. One active key per user.
          </p>
        </div>
        {hasKey ? (
          <Badge variant="outline">1 active key allowed per user</Badge>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
          <CardDescription>
            Secrets appear once. Spend caps, status changes, and rotation reach
            gateway within 1 minute.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <KeysTableSkeleton />
          ) : keysQuery.isError ? (
            <KeysError
              message={humanError(keysQuery.error, "Could not load keys")}
              onRetry={() => void keysQuery.refetch()}
            />
          ) : keys.length === 0 ? (
            <EmptyKeys
              onCreate={() => {
                setRevealed(null);
                setCreateOpen(true);
              }}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border">
                <table className="w-full text-left text-sm">
                  <thead className="hidden border-b bg-muted/40 text-muted-foreground md:table-header-group">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Name
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Key
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Monthly cap
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Created
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Last used
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="block md:table-row-group">
                    {keys.map((key) => (
                      <KeyRow
                        key={key.id}
                        apiKey={key}
                        setting={settingsByKey.get(key.id)}
                        setCap={setCap}
                        setDisabled={setDisabled}
                        onRotate={() => setRotateTarget(key)}
                        onRevoke={() => setRevokeTarget(key)}
                        revokePending={revokeMutation.isPending}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {!hasKey ? (
                <Button
                  className="self-start"
                  onClick={() => {
                    setRevealed(null);
                    setCreateOpen(true);
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Create current key
                </Button>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <SecretRevealDialog
        revealed={revealed}
        copied={copied}
        reduce={reduce}
        onCopy={() => void copySecret()}
        onClose={closeReveal}
      />

      {/* Create form (when no secret revealed yet) */}
      <Dialog
        open={createOpen && revealed === null}
        onOpenChange={(open) => {
          if (!open) closeReveal();
          else setCreateOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-md">
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
                disabled={createMutation.isPending}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeReveal}
                disabled={createMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rotate confirm */}
      <Dialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rotateMutation.isPending) setRotateTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate API key?</DialogTitle>
            <DialogDescription>
              {rotateTarget
                ? `“${rotateTarget.name}” keeps working for 24 hours while you switch over. A new secret is shown once.`
                : "A new key replaces this one."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRotateTarget(null)}
              disabled={rotateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={rotateMutation.isPending || !rotateTarget}
              onClick={() => {
                if (rotateTarget) rotateMutation.mutate(rotateTarget);
              }}
            >
              {rotateMutation.isPending ? "Rotating…" : "Rotate"}
            </Button>
          </DialogFooter>
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

type SettingView = {
  keyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  updatedAt: number;
};

type SetCapFn = (args: {
  keyId: string;
  monthlyCapCredits: number | null;
}) => Promise<unknown>;
type SetDisabledFn = (args: {
  keyId: string;
  disabled: boolean;
}) => Promise<unknown>;

function KeyRow({
  apiKey,
  setting,
  setCap,
  setDisabled,
  onRotate,
  onRevoke,
  revokePending,
}: {
  apiKey: ApiKeyRow;
  setting: SettingView | undefined;
  setCap: SetCapFn;
  setDisabled: SetDisabledFn;
  onRotate: () => void;
  onRevoke: () => void;
  revokePending: boolean;
}) {
  // Local cap input mirrors the persisted value; edits commit on blur.
  const [capInput, setCapInput] = useState(
    setting?.monthlyCapCredits === undefined
      ? ""
      : String(setting.monthlyCapCredits),
  );
  const [capBusy, setCapBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setCapInput(
      setting?.monthlyCapCredits === undefined
        ? ""
        : String(setting.monthlyCapCredits),
    );
  }, [setting?.monthlyCapCredits]);

  function resetCapInput() {
    setCapInput(
      setting?.monthlyCapCredits === undefined
        ? ""
        : String(setting.monthlyCapCredits),
    );
  }

  async function commitCap() {
    const parsed = parseMonthlyCap(capInput);
    if (!parsed.ok) {
      toast.error(parsed.error);
      resetCapInput();
      return;
    }
    const current = setting?.monthlyCapCredits ?? null;
    if (parsed.cap === current) return;
    setCapBusy(true);
    try {
      await setCap({ keyId: apiKey.id, monthlyCapCredits: parsed.cap });
      toast.success(
        parsed.cap === null ? "Monthly cap removed" : "Monthly cap saved",
      );
    } catch (err) {
      toast.error(humanError(err, "Could not save cap"));
      resetCapInput();
    } finally {
      setCapBusy(false);
    }
  }

  async function commitToggle(nextEnabled: boolean) {
    setToggleBusy(true);
    try {
      await setDisabled({ keyId: apiKey.id, disabled: !nextEnabled });
      toast.success(nextEnabled ? "Key enabled" : "Key disabled");
    } catch (err) {
      toast.error(humanError(err, "Could not update key"));
    } finally {
      setToggleBusy(false);
    }
  }

  const graceUntil = setting?.graceUntil;
  const lifecycle = getApiKeyLifecycle(setting, now);
  const graceActive = lifecycle === "grace";
  const graceExpired = lifecycle === "expired";
  const remainingMinutes = graceActive
    ? Math.max(1, Math.ceil((graceUntil! - now) / 60_000))
    : 0;

  return (
    <tr className="block space-y-3 p-4 md:table-row md:space-y-0 md:p-0">
      <td className="flex items-start justify-between gap-4 font-medium md:table-cell md:px-3 md:py-2.5">
        <span className="text-xs font-normal text-muted-foreground md:hidden">
          Name
        </span>
        <span className="min-w-0 break-words text-right md:text-left">
          {apiKey.name}
        </span>
      </td>
      <td className="flex items-center justify-between gap-4 font-mono text-xs text-muted-foreground md:table-cell md:px-3 md:py-2.5">
        <span className="font-sans md:hidden">Key</span>
        {apiKey.masked}
      </td>
      <td className="flex items-center justify-between gap-4 md:table-cell md:px-3 md:py-2.5">
        <span className="text-xs text-muted-foreground md:hidden">
          Monthly cap
        </span>
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          onBlur={() => void commitCap()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Unlimited"
          disabled={capBusy}
          className="h-8 w-28 tabular-nums"
          aria-label={`Monthly credit cap for ${apiKey.name}`}
        />
      </td>
      <td className="flex items-center justify-between gap-4 md:table-cell md:px-3 md:py-2.5">
        <span className="text-xs text-muted-foreground md:hidden">Enabled</span>
        <div className="flex items-center gap-2">
          {lifecycle === "current" || lifecycle === "disabled" ? (
            <Switch
              checked={lifecycle === "current"}
              disabled={toggleBusy}
              onCheckedChange={(checked) => void commitToggle(checked === true)}
              aria-label={`Enable ${apiKey.name}`}
            />
          ) : null}
          {graceActive ? (
            <Badge variant="secondary" className="font-normal">
              Previous — {remainingMinutes}m remaining, until{" "}
              {formatDate(graceUntil!)}
            </Badge>
          ) : graceExpired ? (
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
            >
              Expired — {formatDate(graceUntil!)}
            </Badge>
          ) : lifecycle === "current" ? (
            <Badge variant="secondary" className="font-normal">
              Current
            </Badge>
          ) : lifecycle === "disabled" ? (
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
            >
              Disabled
            </Badge>
          ) : null}
        </div>
      </td>
      <td className="flex justify-between gap-4 text-xs text-muted-foreground tabular-nums md:table-cell md:px-3 md:py-2.5 md:text-sm">
        <span className="md:hidden">Created</span>
        {formatDate(apiKey.createdAt)}
      </td>
      <td className="flex justify-between gap-4 text-xs text-muted-foreground tabular-nums md:table-cell md:px-3 md:py-2.5 md:text-sm">
        <span className="md:hidden">Last used</span>
        {apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : "—"}
      </td>
      <td className="border-t pt-3 text-right md:table-cell md:border-0 md:px-3 md:py-2.5">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRotate}
            disabled={lifecycle !== "current"}
            title="Rotate key (old key works 24h)"
          >
            <RotateCw className="size-4" />
            Rotate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onRevoke}
            disabled={revokePending}
          >
            <Trash2 className="size-4" />
            {graceActive ? "Revoke previous now" : "Revoke"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

function SecretRevealDialog({
  revealed,
  copied,
  reduce,
  onCopy,
  onClose,
}: {
  revealed: RevealedSecret | null;
  copied: boolean;
  reduce: boolean | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={revealed !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
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
                {revealed.graceUntil !== undefined
                  ? " The previous key stays valid for 24 hours."
                  : ""}
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
                  onClick={onCopy}
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
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EmptyKeys({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRound />
        </EmptyMedia>
        <EmptyTitle>No API keys yet</EmptyTitle>
        <EmptyDescription>
          Create one key to call the gateway from curl, SDKs, or agents.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onCreate}>
          <Plus data-icon="inline-start" />
          Create key
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function KeysError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Could not load keys</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </EmptyContent>
    </Empty>
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

function KeysSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Gateway API keys
          </h2>
          <p className="text-sm text-muted-foreground">
            Machine keys for the gateway. One active key per user.
          </p>
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent>
          <KeysTableSkeleton />
        </CardContent>
      </Card>
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
