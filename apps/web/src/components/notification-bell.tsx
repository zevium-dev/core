import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Archive,
  Bell,
  BellOff,
  CheckCheck,
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
 * lucide icon per notification kind. Kinds come from convex/schema.ts
 * (low_balance | spec_published | version_deprecated | webhook_failed |
 * visibility_changed). A fallback covers any future kind without crashing.
 */
const KIND_ICON: Record<string, LucideIcon> = {
  low_balance: Wallet,
  spec_published: Rocket,
  version_deprecated: Archive,
  webhook_failed: Webhook,
  visibility_changed: Eye,
};

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
  const [open, setOpen] = useState(false);
  // Keep relative timestamps fresh while the bell is mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const { data } = useQuery(
    convexQuery(api.notifications.listForOrg, {
      orgSlug,
      paginationOpts: { numItems: 50, cursor: null },
    }),
  );

  const unread = data?.unreadCount ?? 0;

  const markReadMut = useConvexMutation(api.notifications.markRead);
  const markAllMut = useConvexMutation(api.notifications.markAllRead);

  const { mutate: markRead } = useMutation({
    mutationFn: (notificationId: Id<"notifications">) =>
      markReadMut({ notificationId }),
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not mark notification read")),
  });

  const { mutate: markAllRead, isPending: markingAll } = useMutation({
    mutationFn: () => markAllMut({ orgSlug }),
    onSuccess: () => toast.success("All notifications marked read"),
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not mark all read")),
  });

  const page = data?.page ?? [];
  const unreadLabel = unread > 99 ? "99+" : String(unread);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <m.span
              key={unread}
              initial={reduce ? false : { scale: 0 }}
              animate={{ scale: 1 }}
              transition={SPRING.pop}
              className="absolute -top-0.5 -right-0.5 flex min-w-4 h-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white tabular-nums"
            >
              {unreadLabel}
            </m.span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0"
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

        {page.length === 0 ? (
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
                onClick={() => markRead(n._id)}
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
        className="flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left transition-[background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[read=true]:opacity-60 last:border-b-0"
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
