/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import resendTest from "@convex-dev/resend/test";
import { Resend, type EmailId } from "@convex-dev/resend";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  createNotification,
  upsertNotification,
  type NotificationKind,
} from "./lib/notifications";
import { notificationMailer } from "./lib/notificationEmail";

const { members, getUser } = vi.hoisted(() => ({
  members: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { getOrganizationMembershipList: members },
    users: { getUser },
  }),
}));
const modules = import.meta.glob("./**/*.ts");
let send: ReturnType<typeof vi.spyOn<Resend, "sendEmail">>;

beforeEach(async () => {
  // Load action modules before advancing a fake watchdog clock.
  await import("./notificationEmailAction");
  await import("./notificationEmail");
  vi.useFakeTimers();
  vi.stubEnv("RESEND_API_KEY", "resend-test-key");
  vi.stubEnv("EMAIL_FROM", "Zevium <notifications@example.com>");
  vi.stubEnv("CLERK_SECRET_KEY", "clerk-test-key");
  vi.stubEnv("APP_ORIGIN", "https://example.com");
  send = vi
    .spyOn(Resend.prototype, "sendEmail")
    .mockResolvedValue("email-test-id" as EmailId);
  members.mockReset().mockResolvedValue({
    data: [{ publicUserData: { userId: "user_member" } }],
    totalCount: 1,
  });
  getUser.mockReset().mockResolvedValue({
    primaryEmailAddressId: "primary",
    emailAddresses: [
      {
        id: "primary",
        emailAddress: "member@example.com",
        verification: { status: "verified" },
      },
    ],
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setup(kind: NotificationKind = "low_balance") {
  const t = convexTest(schema, modules);
  const notificationId = await t.run(async (ctx) => {
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_test",
      name: "Test Org",
      slug: "test",
    });
    const { id } = await createNotification(ctx, {
      clerkOrgId: "org_test",
      kind,
      title: "Notice <test>",
      body: "Facts & <script>bad</script>\nNext line",
      refId: "event-1",
    });
    return id!;
  });
  const actor = t.withIdentity({
    subject: "user_member",
    org_id: "org_test",
    org_slug: "test",
    org_role: "org:member",
  });
  return {
    t,
    notificationId,
    actor,
    args: { notificationId, revision: 1, offset: 0 },
  };
}

it("stays dormant with no key: inbox exists, skipped is logged, no external calls", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const { t, notificationId } = await setup();
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(await t.run((ctx) => ctx.db.get(notificationId))).toMatchObject({
    emailState: "skipped",
    title: "Notice <test>",
  });
  expect(log).toHaveBeenCalledWith(
    "Notification email skipped: RESEND_API_KEY unset",
    { notificationId },
  );
  expect(members).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it.each<NotificationKind>([
  "low_balance",
  "spec_published",
  "version_deprecated",
  "project_retirement",
  "webhook_failed",
  "visibility_changed",
  "transfer_failed",
  "transfer_sent",
  "quality_suspended",
  "quality_restored",
])(
  "queues %s when configured with escaped HTML and plain text",
  async (kind) => {
    const { t, notificationId } = await setup(kind);
    await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      from: "Zevium <notifications@example.com>",
      to: "member@example.com",
      subject: "Notice <test>",
      idempotencyKey: `notification:${notificationId}:1:user_member`,
    });
    const payload = send.mock.calls[0]![1];
    expect(payload.html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(payload.text).toContain("Facts & <script>bad</script>");
    expect(await t.run((ctx) => ctx.db.get(notificationId))).toMatchObject({
      emailState: "queued",
    });
  },
);

it("persists a real component queue entry and dedupes recipient retries", async () => {
  send.mockRestore();
  const { t, args } = await setup();
  resendTest.register(t);
  const recipient = {
    ...args,
    clerkUserId: "user_member",
    email: "member@example.com",
  };
  await t.mutation(internal.notificationEmail.enqueueRecipient, recipient);
  await t.mutation(internal.notificationEmail.enqueueRecipient, recipient);
  const receipts = await t.run((ctx) =>
    ctx.db.query("notificationEmailDeliveries").collect(),
  );
  expect(receipts).toHaveLength(1);
  const email = await t.run((ctx) =>
    notificationMailer().get(ctx, receipts[0]!.emailId as EmailId),
  );
  expect(email).toMatchObject({
    status: "waiting",
    to: ["member@example.com"],
    subject: "Notice <test>",
  });
  expect(email?.text).toContain("Test Org");
});

it("recovers from partial page failure without duplicating successful recipients", async () => {
  members.mockResolvedValue({
    data: [
      { publicUserData: { userId: "user_member" } },
      { publicUserData: { userId: "user_other" } },
    ],
    totalCount: 2,
  });
  send
    .mockResolvedValueOnce("first" as EmailId)
    .mockRejectedValueOnce(new Error("provider failure"))
    .mockResolvedValue("second" as EmailId);
  const { t } = await setup();
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  const receipts = await t.run((ctx) =>
    ctx.db.query("notificationEmailDeliveries").collect(),
  );
  expect(receipts).toHaveLength(2);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[1]![1].idempotencyKey).toBe(
    send.mock.calls[2]![1].idempotencyKey,
  );
  expect(members).toHaveBeenCalledTimes(2);
});

it("honors per-user/org opt-out, scopes writes to identity, and preserves the inbox", async () => {
  const { t, actor, notificationId } = await setup();
  await actor.mutation(api.notifications.setEmailPreference, {
    orgSlug: "spoofed-other-org",
    emailOptOut: true,
  });
  expect(
    await actor.query(api.notifications.emailPreference, { orgSlug: "test" }),
  ).toEqual({ emailOptOut: true });
  const prefs = await t.run((ctx) =>
    ctx.db.query("notificationPreferences").collect(),
  );
  expect(prefs).toMatchObject([
    { clerkOrgId: "org_test", clerkUserId: "user_member", emailOptOut: true },
  ]);
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.get(notificationId))).not.toBeNull();
  await expect(
    t.mutation(api.notifications.setEmailPreference, {
      orgSlug: "test",
      emailOptOut: true,
    }),
  ).rejects.toThrow("Not authenticated");
});

it("never emails unverified primary addresses or falls back to another address", async () => {
  getUser.mockResolvedValue({
    primaryEmailAddressId: "unverified",
    emailAddresses: [
      {
        id: "unverified",
        emailAddress: "unsafe@example.com",
        verification: { status: "unverified" },
      },
      {
        id: "secondary",
        emailAddress: "other@example.com",
        verification: { status: "verified" },
      },
    ],
  });
  const { t } = await setup();
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).not.toHaveBeenCalled();
});

it("bounds lookup failures and leaves in-app notifications intact", async () => {
  members.mockRejectedValue(new Error("provider private response"));
  const { t, notificationId } = await setup();
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(members).toHaveBeenCalledTimes(5);
  expect(await t.run((ctx) => ctx.db.get(notificationId))).toMatchObject({
    emailState: "failed",
    emailAttempts: 5,
  });
  expect(send).not.toHaveBeenCalled();
});

it("paginates recipients and discards duplicate completed page invocations", async () => {
  members
    .mockResolvedValueOnce({
      data: [{ publicUserData: { userId: "user_member" } }],
      totalCount: 2,
    })
    .mockResolvedValueOnce({
      data: [{ publicUserData: { userId: "user_other" } }],
      totalCount: 2,
    });
  const { t, args } = await setup();
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  await t.action(internal.notificationEmailAction.deliverPage, args);
  expect(send).toHaveBeenCalledTimes(2);
  expect(members.mock.calls[1]?.[0]).toMatchObject({ offset: 1, limit: 25 });
});

it("sends changed lifecycle content once and fences superseded jobs", async () => {
  const { t, args, notificationId } = await setup("project_retirement");
  await t.run((ctx) =>
    upsertNotification(ctx, {
      clerkOrgId: "org_test",
      kind: "project_retirement",
      title: "Canceled",
      body: "API remains available",
      refId: "event-1",
    }),
  );
  await t.action(internal.notificationEmailAction.deliverPage, args);
  expect(send).not.toHaveBeenCalled();
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1]).toMatchObject({
    subject: "Canceled",
    idempotencyKey: `notification:${notificationId}:2:user_member`,
  });
  await t.run((ctx) =>
    upsertNotification(ctx, {
      clerkOrgId: "org_test",
      kind: "project_retirement",
      title: "Canceled",
      body: "API remains available",
      refId: "event-1",
    }),
  );
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).toHaveBeenCalledTimes(1);
});

it("skips missing sender and credentials removed before dispatch", async () => {
  const { t, notificationId } = await setup();
  vi.stubEnv("EMAIL_FROM", "");
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.get(notificationId))).toMatchObject({
    emailState: "skipped",
  });
});

it("does not queue for archived organizations", async () => {
  const { t } = await setup();
  await t.run(async (ctx) => {
    const org = await ctx.db.query("organizations").first();
    await ctx.db.patch(org!._id, { archivedAt: Date.now() });
  });
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).not.toHaveBeenCalled();
});

describe("Resend webhook", () => {
  it("returns 503 when unconfigured and rejects unsigned events", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect(
      (await t.fetch("/resend-webhook", { method: "POST", body: "{}" })).status,
    ).toBe(503);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_" + btoa("test-webhook-secret"));
    expect(
      (await t.fetch("/resend-webhook", { method: "POST", body: "{}" })).status,
    ).toBe(400);
  });
});

it("activation sends only new events; dormant history is not replayed", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  const { t, notificationId } = await setup();
  vi.stubEnv("RESEND_API_KEY", "resend-test-key");
  await t.run(async (ctx) => {
    await createNotification(ctx, {
      clerkOrgId: "org_test",
      kind: "low_balance",
      title: "Old notice",
      body: "Old",
      refId: "event-1",
    });
    await createNotification(ctx, {
      clerkOrgId: "org_test",
      kind: "low_balance",
      title: "New notice",
      body: "New",
      refId: "event-2",
    });
  });
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1].subject).toBe("New notice");
  expect(await t.run((ctx) => ctx.db.get(notificationId))).toMatchObject({
    emailState: "skipped",
  });
});

it("rechecks opt-out before enqueue and does not affect another member", async () => {
  const { t, actor, args } = await setup();
  await actor.mutation(api.notifications.setEmailPreference, {
    orgSlug: "test",
    emailOptOut: true,
  });
  await t.mutation(internal.notificationEmail.enqueueRecipient, {
    ...args,
    clerkUserId: "user_member",
    email: "member@example.com",
  });
  await t.mutation(internal.notificationEmail.enqueueRecipient, {
    ...args,
    clerkUserId: "user_other",
    email: "other@example.com",
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1].to).toBe("other@example.com");
});

it("accepts signed webhook events and returns retryable processing failures", async () => {
  const { Webhook } = await import("svix");
  const secret = "whsec_" + btoa("test-webhook-secret");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
  const t = convexTest(schema, modules);
  const body = JSON.stringify({
    type: "email.delivered",
    data: { email_id: "provider-id" },
  });
  const timestamp = new Date();
  const headers = {
    "svix-id": "event-1",
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign("event-1", timestamp, body),
  };
  const handle = vi
    .spyOn(Resend.prototype, "handleResendEventWebhook")
    .mockResolvedValue(new Response(null, { status: 200 }));
  expect(
    (await t.fetch("/resend-webhook", { method: "POST", headers, body }))
      .status,
  ).toBe(200);
  expect(handle).toHaveBeenCalledTimes(1);
  handle.mockRejectedValueOnce(new Error("private provider failure"));
  expect(
    (await t.fetch("/resend-webhook", { method: "POST", headers, body }))
      .status,
  ).toBe(500);
  expect(
    (
      await t.fetch("/resend-webhook", {
        method: "POST",
        headers,
        body: "tampered",
      })
    ).status,
  ).toBe(400);
  expect(handle).toHaveBeenCalledTimes(2);
});
