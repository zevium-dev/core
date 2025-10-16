import * as orm from "drizzle-orm";
import { z } from "zod";

import * as schema from "./schema";

export const UserZod = z.object({
  createdAt: z.date(),
  email: z.email(),
  emailVerified: z.boolean(),
  id: z.string(),
  image: z.string().nullable(),
  name: z.string(),
  twoFactorEnabled: z.boolean(),
  updatedAt: z.date(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["user"]>>;

export const SessionZod = z.object({
  activeOrganizationId: z.string().nullable(),
  createdAt: z.date(),
  expiresAt: z.date(),
  id: z.string(),
  ipAddress: z.string().nullable(),
  token: z.string(),
  updatedAt: z.date(),
  userAgent: z.string().nullable(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["session"]>>;

export const AccountZod = z.object({
  accessToken: z.string().nullable(),
  accessTokenExpiresAt: z.date().nullable(),
  accountId: z.string(),
  createdAt: z.date(),
  id: z.string(),
  idToken: z.string().nullable(),
  password: z.string().nullable(),
  providerId: z.string(),
  refreshToken: z.string().nullable(),
  refreshTokenExpiresAt: z.date().nullable(),
  scope: z.string().nullable(),
  updatedAt: z.date(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["account"]>>;

export const VerificationZod = z.object({
  createdAt: z.date().nullable(),
  expiresAt: z.date(),
  id: z.string(),
  identifier: z.string(),
  updatedAt: z.date().nullable(),
  value: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["verification"]>>;

export const ApiKeyZod = z.object({
  createdAt: z.date(),
  enabled: z.boolean(),
  expiresAt: z.date().nullable(),
  id: z.string(),
  key: z.string(),
  lastRefillAt: z.date().nullable(),
  lastRequest: z.date().nullable(),
  metadata: z
    .record(z.string(), z.unknown())
    .or(
      z
        .string()
        .transform((val) => JSON.parse(val))
        .pipe(z.record(z.string(), z.unknown())),
    )
    .nullable(),
  name: z.string().nullable(),
  permissions: z.string().nullable(),
  prefix: z.string().nullable(),
  rateLimitEnabled: z.boolean(),
  rateLimitMax: z.number(),
  rateLimitTimeWindow: z.number(),
  refillAmount: z.number().nullable(),
  refillInterval: z.number().nullable(),
  remaining: z.number().nullable(),
  requestCount: z.number(),
  start: z.string().nullable(),
  updatedAt: z.date(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["apikey"]>>;

export const TwoFactorZod = z.object({
  backupCodes: z.string(),
  id: z.string(),
  secret: z.string(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["twoFactor"]>>;

export const OrganizationZod = z.object({
  createdAt: z.date(),
  id: z.string(),
  logo: z.string().nullable(),
  metadata: z
    .record(z.string(), z.unknown())
    .or(
      z
        .string()
        .transform((val) => JSON.parse(val))
        .pipe(z.record(z.string(), z.unknown())),
    )
    .nullable(),
  name: z.string(),
  slug: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["organization"]>>;

export const MemberZod = z.object({
  createdAt: z.date(),
  id: z.string(),
  organizationId: z.string(),
  role: z.string(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["member"]>>;

export const InvitationZod = z.object({
  email: z.email(),
  expiresAt: z.date(),
  id: z.string(),
  inviterId: z.string(),
  organizationId: z.string(),
  role: z.string().nullable(),
  status: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["invitation"]>>;

export const ProjectZod = z.object({
  createdAt: z.date(),
  createdBy: z.string(),
  description: z.string().nullable(),
  id: z.string(),
  metadata: z
    .record(z.string(), z.unknown())
    .or(
      z
        .string()
        .transform((val) => JSON.parse(val))
        .pipe(z.record(z.string(), z.unknown())),
    )
    .nullable(),
  name: z.string(),
  organizationId: z.string(),
  projectCategoryId: z.string().nullable(),
  settings: z.record(z.string(), z.any()),
  slug: z.string(),
  status: z.enum(["active", "inactive", "archived", "beta", "deprecated"]),
  updatedAt: z.date(),
  visibility: z.enum(["public", "private", "internal"]),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["project"]>>;

export const ProjectCategoryZod = z.object({
  createdAt: z.date(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  updatedAt: z.date(),
  weight: z.number(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["projectCategory"]>>;

export const ProjectMemberZod = z.object({
  addedBy: z.string().nullable(),
  id: z.string(),
  joinedAt: z.date(),
  permissions: z.record(z.string(), z.any()),
  projectId: z.string(),
  role: z.enum(["admin", "editor", "viewer"]),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["projectMember"]>>;

export const ApiSpecZod = z.object({
  createdAt: z.date(),
  format: z.enum(["json", "yaml"]),
  hash: z.string(),
  id: z.string(),
  originalRaw: z.string().nullable(),
  projectId: z.string(),
  specJson: z.record(z.string(), z.any()),
  status: z.enum(["active", "deprecated", "archived"]),
  title: z.string().nullable(),
  updatedAt: z.date(),
  versionLabel: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["apiSpec"]>>;

export const ApiEndpointZod = z.object({
  createdAt: z.date(),
  deprecated: z.boolean(),
  id: z.string(),
  method: z.string(),
  operationId: z.string().nullable(),
  path: z.string(),
  security: z.array(z.any()),
  specId: z.string(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["apiEndpoint"]>>;

export const UserPreferenceZod = z.object({
  timezone: z.string(),
  updatedAt: z.date(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["userPreference"]>>;
