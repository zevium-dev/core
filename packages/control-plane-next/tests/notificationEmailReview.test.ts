import { Resend, type EmailId } from "@convex-dev/resend";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harness, seed, identity } from "./helpers";
import { api, internal } from "../convex/_generated/api";
import {
  createNotification,
  upsertNotification,
} from "../convex/lib/notifications";
import { notificationTemplate } from "../convex/lib/notificationEmail";
const mocks = vi.hoisted(() => ({ members: vi.fn(), user: vi.fn() }));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { getOrganizationMembershipList: mocks.members },
    users: { getUser: mocks.user },
  }),
}));
beforeEach(async () => {
  await import("../convex/notificationEmailAction");
  await import("../convex/notificationEmail");
  vi.useFakeTimers();
  vi.stubEnv("RESEND_API_KEY", "fake");
  vi.stubEnv("EMAIL_FROM", "Zevium <notifications@example.com>");
  vi.stubEnv("CLERK_SECRET_KEY", "fake");
  mocks.members.mockReset();
  mocks.user.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("delivers active email with receipts and continues past a bad recipient to later pages", async () => {
  const t = harness(),
    { one } = await seed(t);
  const send = vi
    .spyOn(Resend.prototype, "sendEmail")
    .mockResolvedValue("fake-email-id" as EmailId);
  mocks.members.mockImplementation(async ({ offset }) => ({
    data: [
      {
        publicUserData: { userId: offset === 0 ? "bad" : "good" },
        role: "org:admin",
      },
    ],
    totalCount: 2,
  }));
  mocks.user.mockImplementation(async (id: string) => {
    if (id === "bad") throw new Error("Recipient no longer exists");
    return {
      primaryEmailAddressId: "primary",
      emailAddresses: [
        {
          id: "primary",
          emailAddress: "good@example.com",
          verification: { status: "verified" },
        },
      ],
    };
  });
  const { id } = await t.run((ctx) =>
    createNotification(ctx, {
      organizationId: one,
      kind: "project_retirement",
      title: "Retirement",
      body: "Publisher says <script>bad</script> https://evil.example/path",
      refId: "active-test",
    }),
  );
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toMatchObject({ to: "good@example.com" });
  expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({
    emailState: "queued",
    emailOffset: 1,
  });
  expect(
    await t.run((ctx) => ctx.db.query("notificationEmailDeliveries").collect()),
  ).toHaveLength(1);
  expect(mocks.members.mock.calls.map(([args]) => args.limit)).toEqual([1, 1]);
  await t.action(internal.notificationEmailAction.deliverPage, {
    notificationId: id!,
    revision: 1,
    offset: 1,
  });
  expect(send).toHaveBeenCalledTimes(1);
  const row = (await t.run((ctx) => ctx.db.get(id!)))!;
  const template = notificationTemplate(row, "Org");
  expect(template.html).not.toContain("<script>");
  expect(template.html).not.toContain("https://evil.example");
  expect(template.text).not.toContain("https://evil.example");
  await t.run((ctx) =>
    upsertNotification(ctx, {
      organizationId: one,
      kind: "project_retirement",
      title: "Retirement",
      body: "Edited publisher message",
      refId: "active-test",
      email: false,
    }),
  );
  expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({
    emailRevision: 1,
  });
});
it("restricts webhook failures to admins in inbox, unread count, marking and email", async () => {
  const t = harness(),
    { one } = await seed(t);
  const send = vi
    .spyOn(Resend.prototype, "sendEmail")
    .mockResolvedValue("fake-id" as EmailId);
  mocks.members.mockImplementation(async ({ offset }) => ({
    data: [
      {
        role: offset === 0 ? "org:member" : "org:admin",
        publicUserData: { userId: `user-${offset}` },
      },
    ],
    totalCount: 2,
  }));
  mocks.user.mockResolvedValue({
    primaryEmailAddressId: "primary",
    emailAddresses: [
      {
        id: "primary",
        emailAddress: "admin@example.com",
        verification: { status: "verified" },
      },
    ],
  });
  const { id } = await t.run((ctx) =>
    createNotification(ctx, {
      organizationId: one,
      kind: "webhook_failed",
      title: "Failed",
      body: "Delivery needs review",
      refId: "failed",
    }),
  );
  const member = t.withIdentity(identity("one", "member", "org:member"));
  expect(
    await member.query(api.notifications.unreadForOrg, { orgSlug: "one" }),
  ).toMatchObject({ unreadCount: 0 });
  expect(
    (
      await member.query(api.notifications.listForOrg, {
        orgSlug: "one",
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page,
  ).toHaveLength(0);
  await expect(
    member.mutation(api.notifications.markRead, { notificationId: id! }),
  ).rejects.toThrow("Org admin");
  await member.mutation(api.notifications.markAllRead, { orgSlug: "one" });
  expect(
    await t
      .withIdentity(identity())
      .query(api.notifications.unreadForOrg, { orgSlug: "one" }),
  ).toMatchObject({ unreadCount: 1 });
  await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
  expect(mocks.user).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});
