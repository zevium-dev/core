import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Banknote,
  Bell,
  BellOff,
  CheckCheck,
  CircleAlert,
  Eye,
  Rocket,
  Wallet,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useState, type ComponentType } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { useActiveOrgSlug } from "#/hooks/use-active-org-slug";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { DUR, EASE, SPRING, STAGGER } from "#/lib/motion";
import { formatRelativeTime } from "#/lib/relative-time";
import { vtState } from "#/lib/vt";

/**
 * lucide icon per notification kind. A fallback covers any future kind without
 * crashing, including server-side notifications added before the client ships.
 */
const KIND_ICON: Record<string, LucideIcon> = {
  low_balance: Wallet,
  spec_published: Rocket,
  version_deprecated: Archive,
  webhook_failed: Webhook,
  visibility_changed: Eye,
  transfer_failed: CircleAlert,
  transfer_sent: Banknote,
};

/**
 * kind → destination route, for click-through navigation. The lookup tolerates
 * unknown kinds by returning `undefined`, which means "mark read, don't
 * navigate."
 */
const KIND_DESTINATION = {
  low_balance: "/app/billing",
  spec_published: "/app/projects",
  version_deprecated: "/app/projects",
  webhook_failed: "/app/projects",
  visibility_changed: "/app/projects",
  transfer_failed: "/app/earnings",
  transfer_sent: "/app/earnings",
} as const;

function destinationForKind(
  kind: string,
): (typeof KIND_DESTINATION)[keyof typeof KIND_DESTINATION] | undefined {
  return kind in KIND_DESTINATION
    ? KIND_DESTINATION[kind as keyof typeof KIND_DESTINATION]
    : undefined;
}

const TIME_TICK_MS = 60_000;

export function NotificationBell() {
  const { orgSlug, isLoaded } = useActiveOrgSlug();

  if (!orgSlug) {
    return <DisabledBell ready={isLoaded} />;
  }
  return <BellWithOrg orgSlug={orgSlug} />;
}

/** Static, disabled bell — shown before org loads or when none is selected. */
function DisabledBell({ ready }: { ready: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative text-muted-foreground"
      disabled={!ready}
      aria-label="Select an organization to view notifications"
    >
      <Bell className="size-4" />
    </Button>
  );
}

function BellWithOrg({ orgSlug }: { orgSlug: string }) {
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Keep relative timestamps fresh while the bell is mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const notificationsQuery = useQuery(
    convexQuery(api.notifications.listForOrg, {
      orgSlug,
      paginationOpts: { numItems: 50, cursor: null },
    }),
  );

  const unread = notificationsQuery.isSuccess
    ? notificationsQuery.data.unreadCount
    : 0;
  const unreadCountCapped = notificationsQuery.isSuccess
    ? notificationsQuery.data.unreadCountCapped
    : false;

  const markReadMut = useConvexMutation(api.notifications.markRead);
  const markAllMut = useConvexMutation(api.notifications.markAllRead);

  const { mutate: markRead } = useMutation({
    mutationFn: (notificationId: Id<"notifications">) =>
      markReadMut({ notificationId }),
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not mark notification read")),
  });

  const { mutate: markAllRead, isPending: markingAll } = useMutation({
    mutationFn: async () => {
      let through: number | undefined;
      let hasMore = true;
      while (hasMore) {
        const result = await markAllMut({ orgSlug, through });
        through = result.through;
        hasMore = result.hasMore;
      }
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not mark all read")),
  });

  const page = notificationsQuery.isSuccess ? notificationsQuery.data.page : [];
  const unreadLabel = unreadCountCapped ? "99+" : String(unread);
  const unreadAccessibleLabel = unreadCountCapped
    ? "more than 99 unread"
    : `${unread} unread`;

  function onRowClick(notificationId: Id<"notifications">, kind: string) {
    markRead(notificationId);
    const destination = destinationForKind(kind);
    if (destination !== undefined) {
      void navigate({ to: destination });
    }
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${unread > 0 ? `, ${unreadAccessibleLabel}` : ""}`}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <m.span
              key={unread}
              initial={reduce ? false : { scale: 0 }}
              animate={{ scale: 1 }}
              transition={SPRING.pop}
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-semibold leading-none text-background tabular-nums"
            >
              {unreadLabel}
            </m.span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)] p-0"
        // Reset `now` when opening so the first paint is accurate.
        onOpenAutoFocus={() => setNow(Date.now())}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={markingAll || unread === 0}
            onClick={() => markAllRead()}
          >
            <CheckCheck className="size-3.5" />
            Mark all read
          </Button>
        </div>

        {notificationsQuery.isPending ? (
          <div className="space-y-3 p-3" aria-label="Loading notifications">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex items-start gap-2.5">
                <Skeleton className="size-7 shrink-0 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : notificationsQuery.isError ? (
          <div className="space-y-3 px-4 py-8 text-center" role="alert">
            <p className="text-sm font-medium">Notifications did not load</p>
            <p className="text-xs text-muted-foreground">
              Check your connection, then retry.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void notificationsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : page.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {page.map((n, i) => (
              <NotificationRow
                key={n._id}
                kind={n.kind}
                title={n.title}
                body={n.body}
                createdAt={n.createdAt}
                read={n.readAt !== undefined}
                now={now}
                index={i}
                reduce={Boolean(reduce)}
                onClick={() => onRowClick(n._id, n.kind)}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  kind,
  title,
  body,
  createdAt,
  read,
  now,
  index,
  reduce,
  onClick,
}: {
  kind: string;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  now: number;
  index: number;
  reduce: boolean;
  onClick: () => void;
}) {
  const Icon = (KIND_ICON[kind] ?? Bell) as ComponentType<{
    className?: string;
  }>;
  // Cap stagger so long lists don't string out past 400ms (DESIGN.md).
  const delay = Math.min(index, 7) * STAGGER;
  const skip = reduce || vtState.active;

  return (
    <li>
      <m.button
        type="button"
        initial={skip ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DUR.fast, ease: EASE, delay }}
        onClick={onClick}
        className="flex w-full cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 text-left transition-[background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[read=true]:opacity-60 last:border-b-0"
        data-read={read}
      >
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {formatRelativeTime(createdAt, now)}
            </span>
          </span>
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {body}
          </span>
        </span>
      </m.button>
    </li>
  );
}

function EmptyState() {
  const reduce = useReducedMotion();
  const skip = Boolean(reduce) || vtState.active;
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <m.span
        initial={skip ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DUR.base, ease: EASE }}
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <BellOff className="size-5" />
      </m.span>
      <p className="text-sm font-medium">You&apos;re all caught up</p>
      <p className="text-xs text-muted-foreground">
        New activity in your org shows up here.
      </p>
    </div>
  );
}
