import { ConvexError } from "convex/values";
import { settlement } from "@zevium/shared/edge/settlement";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "#/components/ui/alert-dialog";
import { useState, type ReactNode } from "react";
import {
  useAction,
  useMutation as useConvexMutation,
  usePaginatedQuery,
} from "convex/react";
import { useMutation } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { Skeleton } from "#/components/ui/skeleton";
import { Alert, AlertDescription } from "#/components/ui/alert";

type Case = NonNullable<
  FunctionReturnType<typeof api.admin.getFinanceReconciliationCase>
>;
function PageEnd({
  status,
  loadMore,
}: {
  status: string;
  loadMore: (n: number) => void;
}) {
  return status === "LoadingFirstPage" ? (
    <Skeleton className="h-40 w-full" />
  ) : (
    <Button
      variant="outline"
      disabled={status !== "CanLoadMore"}
      onClick={() => loadMore(25)}
    >
      {status === "LoadingMore"
        ? "Loading…"
        : status === "Exhausted"
          ? "All records loaded"
          : "Load more"}
    </Button>
  );
}
function Operation({
  label,
  run,
  disabled = false,
  destructive = false,
  confirmation,
}: {
  label: string;
  run: () => Promise<unknown>;
  disabled?: boolean;
  destructive?: boolean;
  confirmation?: { id: string; amount: string; effect: string; note: string };
}) {
  const operation = useMutation({
    mutationFn: run,
    onSuccess: (result) => {
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        (result.status === "rejected" || result.status === "exception")
      ) {
        toast.error(
          "Recovery remains blocked. Review the immutable evidence and current wallet state.",
        );
        return;
      }
      toast.success("Operation recorded. Review the updated state.");
    },
    onError: (error) =>
      toast.error(
        operatorError(
          error,
          "Operation could not complete. Review the current record before retrying.",
        ),
      ),
  });
  const button = (
    <Button
      variant={destructive ? "destructive" : "outline"}
      disabled={disabled || operation.isPending}
      onClick={confirmation ? undefined : () => operation.mutate()}
    >
      {operation.isPending ? "Working…" : label}
    </Button>
  );
  if (!confirmation) return button;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}?</AlertDialogTitle>
          <AlertDialogDescription>{confirmation.effect}</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid gap-2 text-sm break-all">
          <dt>Case / wallet ID</dt>
          <dd>{confirmation.id}</dd>
          <dt>Amount</dt>
          <dd>{confirmation.amount}</dd>
          <dt>Audit note</dt>
          <dd className="whitespace-pre-wrap">{confirmation.note}</dd>
        </dl>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={disabled || operation.isPending}
            onClick={() => operation.mutate()}
          >
            Confirm {label.toLowerCase()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function operatorError(error: unknown, fallback: string) {
  // ConvexError data is deliberately curated by our staff endpoints; Error.message includes internals.
  return error instanceof ConvexError && typeof error.data === "string"
    ? error.data
    : humanError(error, fallback);
}
function AuditNote({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (s: string) => void;
  id: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Audit note</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={8}
        maxLength={1000}
        placeholder="Evidence reviewed and reason for this action"
      />
    </div>
  );
}
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}
function CaseDetail({ row }: { row: Case }) {
  const evidence = usePaginatedQuery(
    api.operators.evidence,
    { caseId: row._id },
    { initialNumItems: 25 },
  );
  const [reason, setReason] = useState(""),
    [providerId, setProviderId] = useState("");
  const resolve = useAction(api.operators.resolveException),
    provider = useAction(api.operators.resolveProviderCase);
  const supported = [
    "transfer",
    "account_create",
    "transfer_orphan",
    "foreign_stripe_event",
    "foreign_test_payout",
  ].includes(row.kind);
  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        {row.resolution ?? row.reason}
      </p>
      <ul className="space-y-2">
        {evidence.results.map((e) => (
          <li key={e._id}>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(e, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
      <PageEnd {...evidence} />
      {row.status === "open" && (
        <>
          <AuditNote
            id={`reason-${row._id}`}
            value={reason}
            onChange={setReason}
          />
          {row.kind === "settlement_exception" ? (
            <>
              <Alert>
                <AlertDescription>
                  Resolution records an operator disposition. It does not debit
                  the wallet or create publisher earnings.
                </AlertDescription>
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Operation
                  label="Mark resolved"
                  disabled={reason.trim().length < 8}
                  run={() =>
                    resolve({
                      caseId: row._id,
                      disposition: "resolved",
                      resolution: reason,
                    })
                  }
                />
                <Operation
                  label="Void exception"
                  confirmation={{
                    id: row._id,
                    amount: "0 credits moved",
                    effect:
                      "Permanently records this exception as void. Wallet and publisher balances stay unchanged.",
                    note: reason,
                  }}
                  destructive
                  disabled={reason.trim().length < 8}
                  run={() =>
                    resolve({
                      caseId: row._id,
                      disposition: "void",
                      resolution: reason,
                    })
                  }
                />
              </div>
            </>
          ) : supported ? (
            <>
              <Label htmlFor={`provider-${row._id}`}>
                Verified provider object ID (for adoption)
              </Label>
              <Input
                id={`provider-${row._id}`}
                value={providerId}
                maxLength={256}
                onChange={(e) => setProviderId(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {["transfer", "account_create"].includes(row.kind) && (
                  <Operation
                    label="Verify and adopt"
                    confirmation={{
                      id: row._id,
                      amount:
                        row.transferAmountCents === null
                          ? row.kind === "account_create"
                            ? "Account adoption: no money moved"
                            : "Transfer amount unavailable"
                          : `${row.transferAmountCents} USD cents already transferred`,
                      effect: `Adopt provider object ${providerId} after verifying its exact evidence. This permanently links the provider fact to this case.`,
                      note: reason,
                    }}
                    disabled={
                      reason.trim().length < 8 ||
                      !providerId ||
                      (row.kind === "transfer" &&
                        row.transferAmountCents === null)
                    }
                    run={() =>
                      provider({
                        caseId: row._id,
                        expectedUpdatedAt: row.updatedAt,
                        resolution: "adopt",
                        providerId,
                        reason,
                      })
                    }
                  />
                )}
                <Operation
                  label="Quarantine case"
                  disabled={reason.trim().length < 8}
                  run={() =>
                    provider({
                      caseId: row._id,
                      expectedUpdatedAt: row.updatedAt,
                      resolution: "quarantine",
                      reason,
                    })
                  }
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Use the payment or close controls below for this record.
              Quarantining evidence never releases money.
            </p>
          )}
        </>
      )}
    </div>
  );
}
function ExpandableCase({ row }: { row: Case }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-md border p-4"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {row.kind} · {row.status} · {row.operationId ?? row._id}
      </summary>
      {open && <CaseDetail row={row} />}
    </details>
  );
}
function Cases() {
  const rows = usePaginatedQuery(
    api.admin.listFinanceReconciliationCases,
    { status: "open" },
    { initialNumItems: 25 },
  );
  return (
    <Section
      title="Finance cases"
      description="Provider evidence, ownership ambiguity, and settlement exceptions."
    >
      {rows.results.flatMap((row) =>
        row.rowKind === "case"
          ? [<ExpandableCase key={row._id} row={row} />]
          : [],
      )}
      <PageEnd {...rows} />
    </Section>
  );
}
function Payment({
  row,
}: {
  row: FunctionReturnType<typeof api.operators.payments>["page"][number];
}) {
  const retry = useConvexMutation(api.operators.retryPayment),
    [reason, setReason] = useState("");
  return (
    <details className="rounded-md border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {row.providerPaymentRef} · generation {row.generation}
      </summary>
      <div className="space-y-4 pt-4">
        <p className="text-sm">
          Target reversal {row.targetCredits} credits; applied{" "}
          {row.walletReversedCredits}. {row.attempts} attempts.{" "}
          {row.quarantineComplete
            ? "Affected funds are locked."
            : "Waiting for wallet drain and affected funds to be locked."}
        </p>
        <AuditNote
          id={`payment-${row.id}`}
          value={reason}
          onChange={setReason}
        />
        <Operation
          label="Retry reconciliation"
          disabled={!row.quarantineComplete || reason.trim().length < 8}
          run={() =>
            retry({ paymentId: row.id, generation: row.generation, reason })
          }
        />
      </div>
    </details>
  );
}
function Payments() {
  const rows = usePaginatedQuery(
    api.operators.payments,
    {},
    { initialNumItems: 25 },
  );
  return (
    <Section
      title="Payments needing review"
      description="Retry pauses wallet calls while verified adjustments are applied. Affected funds stay locked until reconciliation finishes."
    >
      {rows.results.map((row) => (
        <Payment key={row.id} row={row} />
      ))}
      <PageEnd {...rows} />
    </Section>
  );
}
function Close({
  row,
}: {
  row: FunctionReturnType<typeof api.operators.closes>["page"][number];
}) {
  const wake = useAction(api.operators.wakeClose),
    abandon = useConvexMutation(api.operators.abandonAdminClose),
    [reason, setReason] = useState("");
  return (
    <details className="rounded-md border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {row.clerkOrgId} · epoch {row.epoch} ·{" "}
        {row.close?.reason ?? "no active close"}
      </summary>
      <div className="space-y-4 pt-4">
        <p className="text-sm">
          Settled through {row.watermark}. Final edge sequence{" "}
          {row.close?.edgeFinalSequence ?? "awaiting acknowledgement"}.
          Requested{" "}
          {row.close ? new Date(row.close.requestedAt).toISOString() : "—"}.
        </p>
        <Operation
          label="Wake edge reconciliation"
          run={() => wake({ walletId: row.id })}
        />
        {row.close?.canAbandon && (
          <>
            <AuditNote
              id={`close-${row.id}`}
              value={reason}
              onChange={setReason}
            />
            <Operation
              label="Abandon drained admin decrease"
              confirmation={{
                id: row.id,
                amount: `${row.balance} credits remain; 0 credits moved`,
                effect:
                  "Cancel this drained admin decrease and reopen the wallet. No ledger effects are applied.",
                note: reason,
              }}
              destructive
              disabled={reason.trim().length < 8}
              run={() =>
                abandon({ walletId: row.id, closeId: row.close!.id, reason })
              }
            />
            <p className="text-sm text-muted-foreground">
              Requires a fully drained admin close with no ledger effects.
              Refund and dispute closes cannot be abandoned.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
function Closes({ state }: { state: "closing" | "maintenance" | "closed" }) {
  const rows = usePaginatedQuery(
    api.operators.closes,
    { state },
    { initialNumItems: 25 },
  );
  return (
    <Section
      title={`Wallets: ${state}`}
      description="Drain acknowledgement and settlement progress update live."
    >
      {rows.results.map((row) => (
        <Close key={row.id} row={row} />
      ))}
      <PageEnd {...rows} />
    </Section>
  );
}
function RejectedFinal() {
  const [org, setOrg] = useState(""),
    [reference, setReference] = useState(""),
    [reason, setReason] = useState("");
  const load = useAction(api.operators.exportRejected),
    recover = useConvexMutation(api.operators.recoverRejected);
  const evidence = useMutation({
    mutationFn: () => load({ clerkOrgId: org, settleRefId: reference }),
    onError: (error) =>
      toast.error(
        operatorError(error, "Could not load rejected final evidence."),
      ),
  });
  const recovered = (() => {
    try {
      const parsed = evidence.data
        ? settlement.safeParse(JSON.parse(evidence.data.eventJson))
        : null;
      return parsed?.success ? parsed.data : null;
    } catch {
      return null;
    }
  })();
  const current = evidence.variables !== undefined || evidence.isSuccess;
  return (
    <Section
      title="Rejected finals"
      description="Load exact retained edge evidence by organization and settlement reference. Recovery preserves its original digest and watermark."
    >
      <Label htmlFor="rejected-org">Clerk organization ID</Label>
      <Input
        id="rejected-org"
        value={org}
        maxLength={512}
        onChange={(e) => {
          setOrg(e.target.value);
          evidence.reset();
        }}
      />
      <Label htmlFor="rejected-ref">Settlement reference</Label>
      <Input
        id="rejected-ref"
        value={reference}
        maxLength={512}
        onChange={(e) => {
          setReference(e.target.value);
          evidence.reset();
        }}
      />
      <Button
        disabled={!org || !reference || evidence.isPending}
        onClick={() => evidence.mutate()}
      >
        {evidence.isPending ? "Loading evidence…" : "Load retained evidence"}
      </Button>
      {evidence.isPending && <Skeleton className="h-40 w-full" />}
      {current && evidence.data === null && (
        <p>No retained failure matches this reference.</p>
      )}
      {evidence.data && (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(evidence.data, null, 2)}
          </pre>
          <AuditNote id="rejected-note" value={reason} onChange={setReason} />
          <Operation
            label="Recover exact final"
            confirmation={{
              id: recovered?.walletId ?? org,
              amount: recovered
                ? `${recovered.credits} credits`
                : "Unavailable",
              effect:
                "Replay this exact retained settlement. Valid evidence can debit backed credits and create publisher earnings; exception outcomes record served usage without payment.",
              note: reason,
            }}
            disabled={reason.trim().length < 8 || !recovered}
            run={() => recover({ ...evidence.data!, reason })}
          />
          <p className="text-sm text-muted-foreground">
            Immutable evidence conflicts remain blocked. Exception recovery
            records served usage without claiming a paid settlement.
          </p>
        </>
      )}
    </Section>
  );
}
export function OperatorConsole() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Operator exceptions</h1>
        <p className="text-muted-foreground">
          Review evidence before changing a case. All actions require platform
          staff access.
        </p>
      </div>
      <Cases />
      <RejectedFinal />
      <Payments />
      <Closes state="closing" />
      <Closes state="maintenance" />
      <Closes state="closed" />
    </div>
  );
}
