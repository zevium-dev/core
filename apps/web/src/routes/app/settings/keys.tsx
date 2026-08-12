import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useAuth, useOrganization } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Check, Copy, KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import {
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
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
import { isPrivilegedOrgRole } from "#/lib/org-capabilities";
import { safeReturnPath } from "#/lib/return-path";

function keysQueryKey(userId: string, orgId: string) {
  return ["settings", "api-keys", userId, orgId] as const;
}
const KEY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** Secret reveal shape shared by create + rotate. */
type RevealedSecret = {
  id: string;
  name: string;
  secret: string;
  createdAt: number;
  graceUntil?: number;
};

export const Route = createFileRoute("/app/settings/keys")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: safeReturnPath(search.returnTo, "") || undefined,
  }),
  component: KeysPage,
  head: () => ({
    meta: [{ title: "API keys · Zevium" }],
  }),
});

function KeysPage() {
  const { isLoaded } = useOrganization();
  const { isLoaded: authLoaded, userId, orgId } = useAuth();
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthed } =
    useConvexAuth();

  if (!isLoaded || !authLoaded || convexAuthLoading || !userId || !orgId) {
    return <KeysSkeleton />;
  }
  if (!convexAuthed) {
    return <KeysSkeleton />;
  }

  return (
    <Suspense fallback={<KeysSkeleton />}>
      <KeysContent key={`${userId}:${orgId}`} userId={userId} orgId={orgId} />
    </Suspense>
  );
}

function KeysContent({ userId, orgId }: { userId: string; orgId: string }) {
  const { membership } = useOrganization();
  const canAdminister = isPrivilegedOrgRole(membership?.role);
  const { returnTo } = Route.useSearch();
  const queryClient = useQueryClient();
  const reduce = useReducedMotion();
  const principalKey = `${userId}:${orgId}`;
  const activePrincipalRef = useRef<string | null>(principalKey);
  const queryKey = keysQueryKey(userId, orgId);

  useLayoutEffect(() => {
    activePrincipalRef.current = principalKey;
    return () => {
      activePrincipalRef.current = null;
    };
  }, [principalKey]);

  const keysQuery = useQuery({
    queryKey,
    queryFn: () => listKeys(),
  });

  // Realtime key-settings (cap, disabled, grace) from the control plane.
  const { data: settingsData } = useSuspenseQuery(
    convexQuery(api.keySettings.getForOrg, {}),
  );
  const settingsByKey = new Map((settingsData ?? []).map((s) => [s.keyId, s]));

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [nameSubmitted, setNameSubmitted] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeyRow | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const revokeTriggerRef = useRef<HTMLElement | null>(null);
  const revealedRef = useRef<RevealedSecret | null>(revealed);
  revealedRef.current = revealed;

  const createMutation = useMutation({
    mutationFn: async (keyName: string) => ({
      principalKey,
      created: await createKey({ data: { name: keyName } }),
    }),
    onSuccess: ({ principalKey: completedPrincipal, created }) => {
      if (activePrincipalRef.current !== completedPrincipal) return;
      setRevealed(created);
      setName("");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      if (activePrincipalRef.current !== principalKey) return;
      toast.error(humanError(err, "Could not create API key"));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => ({
      principalKey,
      result: await revokeKey({ data: { id } }),
    }),
    onSuccess: ({ principalKey: completedPrincipal }) => {
      if (activePrincipalRef.current !== completedPrincipal) return;
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      if (activePrincipalRef.current !== principalKey) return;
      toast.error(humanError(err, "Could not revoke API key"));
    },
  });

  const setDisabled = useConvexMutation(api.keySettings.setDisabled);
  const setCap = useConvexMutation(api.keySettings.setCap);
  const rotationOperationIds = useRef(new Map<string, string>());

  const rotateMutation = useMutation({
    mutationFn: async (
      target: ApiKeyRow,
    ): Promise<{ principalKey: string; created: RotateApiKeyResult }> => {
      const operationId =
        rotationOperationIds.current.get(target.id) ?? crypto.randomUUID();
      rotationOperationIds.current.set(target.id, operationId);
      return {
        principalKey,
        created: await rotateKey({ data: { id: target.id, operationId } }),
      };
    },
    onSuccess: ({ principalKey: completedPrincipal, created }) => {
      if (activePrincipalRef.current !== completedPrincipal) return;
      setRevealed(created);
      setRotateTarget(null);
      rotationOperationIds.current.clear();
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      if (activePrincipalRef.current !== principalKey) return;
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
    setNameSubmitted(false);
    setRevealed(null);
    setCopied(false);
  }

  function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (createMutation.isPending || hasKey) return;
    setNameSubmitted(true);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      nameInputRef.current?.focus();
      return;
    }
    createMutation.mutate(trimmed);
  }

  async function copySecret() {
    if (!revealed) return;
    const copiedForPrincipal = principalKey;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      if (activePrincipalRef.current !== copiedForPrincipal) return;
      setCopied(true);
      window.setTimeout(() => {
        if (activePrincipalRef.current === copiedForPrincipal) setCopied(false);
      }, 1500);
    } catch {
      if (activePrincipalRef.current !== copiedForPrincipal) return;
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
        <div className="flex flex-wrap items-center gap-2">
          {returnTo ? (
            <Button asChild variant="outline" size="sm">
              <a href={returnTo}>Return to API</a>
            </Button>
          ) : null}
          {hasKey ? (
            <Badge variant="outline">1 active key allowed per user</Badge>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
          <CardDescription>
            Secrets appear once. Spend caps, status changes, and rotation reach
            gateway within 1 minute.
          </CardDescription>
          {!canAdminister ? (
            <p className="text-sm text-muted-foreground">
              You can create your own key. Organization admins manage caps,
              rotation, status, and revocation.
            </p>
          ) : null}
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
              onCreate={(trigger) => {
                dialogTriggerRef.current = trigger;
                setRevealed(null);
                setCreateOpen(true);
              }}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border">
                <table className="w-full text-left text-sm">
                  <thead className="hidden border-b bg-muted/40 text-muted-foreground lg:table-header-group">
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
                  <tbody className="block lg:table-row-group">
                    {keys.map((key) => (
                      <KeyRow
                        key={key.id}
                        apiKey={key}
                        setting={settingsByKey.get(key.id)}
                        setCap={setCap}
                        setDisabled={setDisabled}
                        onRotate={(trigger) => {
                          dialogTriggerRef.current = trigger;
                          setRotateTarget(key);
                        }}
                        onRevoke={(trigger) => {
                          revokeTriggerRef.current = trigger;
                          setRevokeTarget(key);
                        }}
                        revokePending={revokeMutation.isPending}
                        canAdminister={canAdminister}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {!hasKey ? (
                <Button
                  className="self-start"
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget;
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
        restoreFocusRef={dialogTriggerRef}
      />

      {/* Create form (when no secret revealed yet) */}
      <Dialog
        open={createOpen && revealed === null}
        onOpenChange={(open) => {
          if (!open) closeReveal();
          else setCreateOpen(true);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (revealedRef.current === null) dialogTriggerRef.current?.focus();
          }}
        >
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
                ref={nameInputRef}
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Local dev"
                maxLength={64}
                disabled={createMutation.isPending}
                aria-invalid={nameSubmitted && name.trim() === ""}
                aria-describedby="key-name-help"
              />
              <p
                id="key-name-help"
                role={nameSubmitted && name.trim() === "" ? "alert" : undefined}
                className={`min-h-5 text-xs ${
                  nameSubmitted && name.trim() === ""
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {nameSubmitted && name.trim() === ""
                  ? "Enter a name so you can identify where this key is used."
                  : "Use a short location or workload name, such as Local dev."}
              </p>
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
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (revealedRef.current === null) dialogTriggerRef.current?.focus();
          }}
        >
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
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            revokeTriggerRef.current?.focus();
          }}
        >
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
  canAdminister,
}: {
  apiKey: ApiKeyRow;
  setting: SettingView | undefined;
  setCap: SetCapFn;
  setDisabled: SetDisabledFn;
  onRotate: (trigger: HTMLButtonElement) => void;
  onRevoke: (trigger: HTMLButtonElement) => void;
  revokePending: boolean;
  canAdminister: boolean;
}) {
  // Local cap input mirrors the persisted value; edits commit on blur.
  const [capInput, setCapInput] = useState(
    setting?.monthlyCapCredits === undefined
      ? ""
      : String(setting.monthlyCapCredits),
  );
  const [capBusy, setCapBusy] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const capErrorId = useId();
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

  async function commitCap() {
    const parsed = parseMonthlyCap(capInput);
    if (!parsed.ok) {
      setCapError(parsed.error);
      return;
    }
    setCapError(null);
    const current = setting?.monthlyCapCredits ?? null;
    if (parsed.cap === current) return;
    setCapBusy(true);
    try {
      await setCap({ keyId: apiKey.id, monthlyCapCredits: parsed.cap });
    } catch (err) {
      setCapError(humanError(err, "Could not save cap. Retry."));
    } finally {
      setCapBusy(false);
    }
  }

  async function commitToggle(nextEnabled: boolean) {
    setToggleBusy(true);
    try {
      await setDisabled({ keyId: apiKey.id, disabled: !nextEnabled });
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
    <tr className="block space-y-3 p-4 lg:table-row lg:space-y-0 lg:p-0">
      <td className="flex items-start justify-between gap-4 font-medium lg:table-cell lg:px-3 lg:py-2.5">
        <span className="text-xs font-normal text-muted-foreground lg:hidden">
          Name
        </span>
        <span className="min-w-0 break-words text-right lg:text-left">
          {apiKey.name}
        </span>
      </td>
      <td className="flex items-center justify-between gap-4 font-mono text-xs text-muted-foreground lg:table-cell lg:px-3 lg:py-2.5">
        <span className="font-sans lg:hidden">Key</span>
        {apiKey.masked}
      </td>
      <td className="flex items-center justify-between gap-4 lg:table-cell lg:px-3 lg:py-2.5">
        <span className="text-xs text-muted-foreground lg:hidden">
          Monthly cap
        </span>
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={capInput}
          onChange={(e) => {
            const value = e.target.value;
            setCapInput(value);
            if (capError !== null) {
              const parsed = parseMonthlyCap(value);
              setCapError(parsed.ok ? null : parsed.error);
            }
          }}
          onBlur={() => void commitCap()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Unlimited"
          disabled={capBusy || !canAdminister}
          className="h-8 w-28 tabular-nums"
          aria-label={`Monthly credit cap for ${apiKey.name}`}
          aria-invalid={capError !== null}
          aria-describedby={capError ? capErrorId : undefined}
        />
        {capError ? (
          <p
            id={capErrorId}
            role="alert"
            className="mt-1 max-w-48 text-xs text-destructive"
          >
            {capError}
          </p>
        ) : null}
      </td>
      <td className="flex items-center justify-between gap-4 lg:table-cell lg:px-3 lg:py-2.5">
        <span className="text-xs text-muted-foreground lg:hidden">Enabled</span>
        <div className="flex items-center gap-2">
          {lifecycle === "current" || lifecycle === "disabled" ? (
            <Switch
              checked={lifecycle === "current"}
              disabled={toggleBusy || !canAdminister}
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
      <td className="flex justify-between gap-4 text-xs text-muted-foreground tabular-nums lg:table-cell lg:px-3 lg:py-2.5 lg:text-sm">
        <span className="lg:hidden">Created</span>
        {formatDate(apiKey.createdAt)}
      </td>
      <td className="flex justify-between gap-4 text-xs text-muted-foreground tabular-nums lg:table-cell lg:px-3 lg:py-2.5 lg:text-sm">
        <span className="lg:hidden">Last used</span>
        {apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : "—"}
      </td>
      <td className="border-t pt-3 text-right lg:table-cell lg:border-0 lg:px-3 lg:py-2.5">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Rotate API key"
            onClick={(event) => onRotate(event.currentTarget)}
            disabled={!canAdminister || lifecycle !== "current"}
            title="Rotate key (old key works 24h)"
          >
            <RotateCw className="size-4" />
            Rotate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={(event) => onRevoke(event.currentTarget)}
            disabled={!canAdminister || revokePending}
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
  restoreFocusRef,
}: {
  revealed: RevealedSecret | null;
  copied: boolean;
  reduce: boolean | null;
  onCopy: () => void;
  onClose: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      open={revealed !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusRef.current?.focus();
        }}
      >
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

function EmptyKeys({
  onCreate,
}: {
  onCreate: (trigger: HTMLButtonElement) => void;
}) {
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
        <Button onClick={(event) => onCreate(event.currentTarget)}>
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
    return KEY_DATE_FORMATTER.format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}
