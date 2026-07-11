import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useOrganization } from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Check, Copy, KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { Suspense, useEffect, useState, type FormEvent } from "react";
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
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { parseMonthlyCap } from "#/lib/key-cap";
import { DUR, EASE } from "#/lib/motion";
import { triggerGatewayGrantSync } from "#/lib/wallet-sync";

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
  const { organization, isLoaded } = useOrganization();
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
      <KeysContent clerkOrgId={organization?.id ?? null} />
    </Suspense>
  );
}

function KeysContent({ clerkOrgId }: { clerkOrgId: string | null }) {
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
  const recordRotation = useConvexMutation(api.keySettings.recordRotation);

  const rotateMutation = useMutation({
    mutationFn: async (target: ApiKeyRow): Promise<RotateApiKeyResult> => {
      const created = await rotateKey({ data: { id: target.id } });
      await recordRotation({
        oldKeyId: target.id,
        newKeyId: created.id,
        graceUntil: created.graceUntil,
      });
      return created;
    },
    onSuccess: (created) => {
      setRevealed(created);
      setRotateTarget(null);
      toast.success("Key rotated — copy the new secret now");
      void queryClient.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
      void syncGateway(clerkOrgId);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not rotate API key"));
    },
  });

  const keys = keysQuery.data ?? [];
  const hasKey = keys.length > 0;
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
          title={
            hasKey
              ? "Rotate or revoke the existing key before creating another"
              : undefined
          }
        >
          <Plus className="size-4" />
          Create key
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
          <CardDescription>
            Secrets are shown once at creation. Per-key caps, enable/disable,
            and rotation take effect at the gateway within a minute.
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
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Key</th>
                    <th className="px-3 py-2 font-medium">Monthly cap</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium">Last used</th>
                    <th className="px-3 py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <KeyRow
                      key={key.id}
                      apiKey={key}
                      setting={settingsByKey.get(key.id)}
                      clerkOrgId={clerkOrgId}
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
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Prefer account overview?{" "}
        <Link to="/app/settings" className="link-draw text-foreground">
          Back to settings
        </Link>
      </p>

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
                autoFocus
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
  clerkOrgId,
  setCap,
  setDisabled,
  onRotate,
  onRevoke,
  revokePending,
}: {
  apiKey: ApiKeyRow;
  setting: SettingView | undefined;
  clerkOrgId: string | null;
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
      void syncGateway(clerkOrgId);
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
      void syncGateway(clerkOrgId);
      toast.success(nextEnabled ? "Key enabled" : "Key disabled");
    } catch (err) {
      toast.error(humanError(err, "Could not update key"));
    } finally {
      setToggleBusy(false);
    }
  }

  const graceActive =
    setting?.graceUntil !== undefined && setting.graceUntil > Date.now();

  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2.5 font-medium">{apiKey.name}</td>
      <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
        {apiKey.masked}
      </td>
      <td className="px-3 py-2.5">
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
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Switch
            checked={!setting?.disabled}
            disabled={toggleBusy}
            onCheckedChange={(checked) => void commitToggle(checked === true)}
            aria-label={`Enable ${apiKey.name}`}
          />
          {graceActive ? (
            <Badge variant="secondary" className="font-normal">
              Grace {formatDateShort(setting!.graceUntil!)}
            </Badge>
          ) : setting?.disabled ? (
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
            >
              Disabled
            </Badge>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
        {formatDate(apiKey.createdAt)}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
        {apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRotate}
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
            Revoke
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

function KeysSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
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

/** Best-effort: tell the gateway wallet DO to re-sync so settings land fast. */
function syncGateway(clerkOrgId: string | null): Promise<void> {
  if (!clerkOrgId) return Promise.resolve();
  return triggerGatewayGrantSync(
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
    clerkOrgId,
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

function formatDateShort(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(
      new Date(ms),
    );
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
