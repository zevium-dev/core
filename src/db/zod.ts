import * as orm from "drizzle-orm";
import { z } from "zod";

import * as schema from "./schema";

const MetadataZod = z
  .record(z.string(), z.unknown())
  .or(
    z
      .string()
      .transform((val) => JSON.parse(val))
      .pipe(z.record(z.string(), z.unknown())),
  )
  .nullable();

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
  metadata: MetadataZod,
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
  metadata: MetadataZod,
  name: z.string(),
  slug: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["organization"]>>;

export const MemberZod = z.object({
  createdAt: z.date(),
  id: z.string(),
  organizationId: z.string(),
  role: z.enum(["owner", "member", "admin", "guest"]),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["member"]>>;

export const InvitationZod = z.object({
  email: z.email(),
  expiresAt: z.date(),
  id: z.string(),
  inviterId: z.string(),
  organizationId: z.string(),
  role: z.enum(["owner", "member", "admin", "guest"]),
  status: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["invitation"]>>;

export const ProjectZod = z.object({
  createdAt: z.date(),
  deletedAt: z.date().nullable(),
  description: z.string(),
  documentation: z.string(),
  id: z.string(),
  metadata: MetadataZod,
  name: z.string(),
  organizationId: z.string(),
  slug: z.string(),
  status: z.enum(["draft", "preview", "active", "archived"]),
  updatedAt: z.date(),
  visibility: z.enum(["public", "private"]),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["project"]>>;

export const TagZod = z.object({
  createdAt: z.date(),
  createdBy: z.string().nullable(),
  id: z.string(),
  metadata: MetadataZod,
  name: z.string(),
  status: z.enum(["active", "archived"]),
  updatedAt: z.date(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["tag"]>>;

export const ProjectTagZod = z.object({
  id: z.string(),
  projectId: z.string(),
  tagName: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["projectTag"]>>;

export const OrganizationTagZod = z.object({
  id: z.string(),
  organizationId: z.string(),
  tagName: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["organizationTag"]>>;

export const OpenAPISchemaZod = z.object({
  createdAt: z.date(),
  draft: z.unknown(),
  id: z.string(),
  metadata: MetadataZod,
  projectId: z.string(),
  updatedAt: z.date(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["openAPISchema"]>>;

export const OpenAPISchemaVersionZod = z.object({
  createdAt: z.date(),
  id: z.string(),
  openAPISchemaId: z.string(),
  schema: z.unknown(),
  updatedAt: z.date(),
  version: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["openAPISchemaVersion"]>>;

export const UserPreferenceZod = z.object({
  timezone: z.string(),
  updatedAt: z.date(),
  userId: z.string(),
}) satisfies z.ZodType<orm.InferSelectModel<(typeof schema)["userPreference"]>>;
