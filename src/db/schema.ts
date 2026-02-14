import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { DefaultOrganizationRoles } from "./default-roles";
import { OrganizationUserPermissions, PermissionValue, ProjectUserPermissions, UserPermissions } from "./permission";

type Base64String = {} & string;
type Metadata = Record<string, unknown>;

// ===== Credits =====
export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    // positive for top-up, negative for deduction, in cents
    amountCents: integer("amount_cents").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    description: text("description"),
    id: text("id").primaryKey(),
    reference: text("reference"),
    type: text("type", { enum: ["topup", "deduct", "adjust"] as const }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [
    index("credit_ledger_user_id_index").on(self.userId),
    index("credit_ledger_created_at_index").on(self.createdAt),
  ],
);

export const user = sqliteTable(
  "user",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .$defaultFn(() => false)
      .notNull(),
    id: text("id").primaryKey(),
    image: text("image"),
    name: text("name").notNull(),
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(false).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (self) => [index("user_email_index").on(self.email)],
);

export const session = sqliteTable(
  "session",
  {
    activeOrganizationId: text("active_organization_id").references(() => organization.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [index("session_user_id_index").on(self.userId), index("session_expires_at_index").on(self.expiresAt)],
);

export const account = sqliteTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [
    index("account_user_id_index").on(self.userId),
    uniqueIndex("account_provider_account_unique_index").on(self.providerId, self.accountId),
  ],
);

export const verification = sqliteTable("verification", {
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  value: text("value").notNull(),
});

// ===== API Keys =====

export const apikey = sqliteTable(
  "apikey",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    lastRefillAt: integer("last_refill_at", { mode: "timestamp" }),
    lastRequest: integer("last_request", { mode: "timestamp" }),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    name: text("name"),
    permissions: text("permissions"),
    prefix: text("prefix"),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(true).notNull(),
    rateLimitMax: integer("rate_limit_max").default(10).notNull(),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000).notNull(),
    refillAmount: integer("refill_amount"),
    refillInterval: integer("refill_interval"),
    remaining: integer("remaining"),
    requestCount: integer("request_count").default(0).notNull(),
    start: text("start"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [
    index("apikey_user_id_index").on(self.userId),
    uniqueIndex("apikey_key_index").on(self.key),
  ],
);

// === Two-Factor Authentication =====

export const twoFactor = sqliteTable(
  "two_factor",
  {
    backupCodes: text("backup_codes").notNull(),
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [index("two_factor_user_id_index").on(self.userId)],
);

// ===== Organizations =====

export const organization = sqliteTable(
  "organization",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    id: text("id").primaryKey(),
    logo: text("logo").$type<Base64String>(),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
  },
  (self) => [uniqueIndex("organization_slug_index").on(self.slug)],
);

export const member = sqliteTable(
  "member",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role", { enum: DefaultOrganizationRoles })
      .notNull()
      .$defaultFn(() => "member"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [
    index("member_organization_id_index").on(self.organizationId),
    index("member_user_id_index").on(self.userId),
    uniqueIndex("member_organization_user_unique_index").on(self.organizationId, self.userId),
  ],
);

export const invitation = sqliteTable(
  "invitation",
  {
    email: text("email").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    id: text("id").primaryKey(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role", { enum: DefaultOrganizationRoles })
      .notNull()
      .$defaultFn(() => "member"),
    status: text("status").default("pending").notNull(),
  },
  (self) => [
    index("invitation_inviter_id_index").on(self.inviterId),
    index("invitation_organization_id_index").on(self.organizationId),
  ],
);

// ===== Projects =====

export const project = sqliteTable(
  "project",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    description: text("description").default("").notNull(),
    /** Markdown format */
    documentation: text("documentation").default("").notNull(),
    id: text("id").primaryKey(),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    slug: text("slug").unique().notNull(),
    /**
     * draft - the user can't use it yet
     * preview - the user can see and use it but shows a "preview" badge
     * active - fully active project
     * archived - read-only project, doesn't show up in searches and calls to this fail
     */
    status: text("status", { enum: ["draft", "preview", "active", "archived"] })
      .notNull()
      .$defaultFn(() => "draft"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    variables: text("variables", { mode: "json" })
      .$defaultFn(() => [])
      .$type<Array<{ name: string; value: string }>>(),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .$defaultFn(() => "private"),
  },
  (self) => [
    index("project_organization_id_index").on(self.organizationId),
    // to be able to show "recently created/updated" projects
    index("project_created_at_index").on(self.createdAt),
    index("project_updated_at_index").on(self.updatedAt),
    // Projects can have same slugs, but not within the same org
    uniqueIndex("project_slug_organization_id_index").on(self.slug, self.organizationId),
  ],
);

/** Instead of categories, we gonna use tags to determine the category */
export const tag = sqliteTable(
  "tag",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    id: text("id").primaryKey(),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    name: text("name").notNull().unique(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .$defaultFn(() => "active"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (self) => [index("tag_created_by_index").on(self.createdBy), uniqueIndex("tag_name_index").on(self.name)],
);

/** Instead of categories, we gonna use tags to determine the category */
export const projectTag = sqliteTable(
  "project_tag",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    tagName: text("tag_name")
      .notNull()
      .references(() => tag.name, { onDelete: "cascade" }),
  },
  (self) => [
    index("project_tag_project_id_index").on(self.projectId),
    index("project_tag_tag_name_index").on(self.tagName),
    uniqueIndex("project_tag_unique_index").on(self.projectId, self.tagName),
  ],
);

/** Instead of categories, we gonna use tags to determine the category */
export const organizationTag = sqliteTable(
  "organization_tag",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    tagName: text("tag_name")
      .notNull()
      .references(() => tag.name, { onDelete: "cascade" }),
  },
  (self) => [
    index("organization_tag_organization_id_index").on(self.organizationId),
    index("organization_tag_tag_name_index").on(self.tagName),
    uniqueIndex("organization_tag_unique_index").on(self.organizationId, self.tagName),
  ],
);

// ===== OpenAPI schemas =====

export const openAPISchema = sqliteTable(
  "openapi_schema",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    draft: text("draft", { mode: "json" })
      .notNull()
      .$defaultFn(() => ({})),
    id: text("id").primaryKey(),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  // 1-1 relationship with project
  (self) => [uniqueIndex("openapi_schema_project_id_index").on(self.projectId)],
);

export const openAPISchemaVersion = sqliteTable(
  "openapi_schema_version",
  {
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    id: text("id").primaryKey(),
    openAPISchemaId: text("openapi_schema_id")
      .notNull()
      .references(() => openAPISchema.id, { onDelete: "cascade" }),
    schema: text("schema", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    version: text("version").notNull(),
  },
  (self) => [
    index("openapi_schema_version_openapi_schema_id_index").on(self.openAPISchemaId),
    index("openapi_schema_version_number_index").on(self.version),
    uniqueIndex("openapi_schema_version_number_index").on(self.openAPISchemaId, self.version),
  ],
);

// ===== User Preferences =====

export const userPreference = sqliteTable(
  "user_preference",
  {
    timezone: text("timezone").notNull().default("UTC"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    // primary key also FK to user
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  // 1-1 relationship with user
  (self) => [uniqueIndex("user_preference_user_id_index").on(self.userId)],
);

// ===== Permissions =====

export const userPermission = sqliteTable(
  "user_permission",
  {
    id: text("id").primaryKey(),
    permission: text("permission", { enum: UserPermissions }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    value: text("value", { mode: "json" }).notNull().$type<PermissionValue>(),
  },
  (self) => [
    index("user_permission_user_id_index").on(self.userId),
    uniqueIndex("user_permission_user_permission_unique_index").on(self.userId, self.permission),
  ],
);

export const organizationUserPermission = sqliteTable(
  "organization_user_permission",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    permission: text("permission", { enum: OrganizationUserPermissions }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    value: text("value", { mode: "json" }).notNull().$type<PermissionValue>(),
  },
  (self) => [
    index("organization_user_permission_organization_id_index").on(self.organizationId),
    index("organization_user_permission_user_id_index").on(self.userId),
    uniqueIndex("organization_user_permission_unique_index").on(self.organizationId, self.userId, self.permission),
  ],
);

export const projectUserPermission = sqliteTable(
  "project_user_permission",
  {
    id: text("id").primaryKey(),
    permission: text("permission", { enum: ProjectUserPermissions }).notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    value: text("value", { mode: "json" }).notNull().$type<PermissionValue>(),
  },
  (self) => [
    index("project_user_permission_project_id_index").on(self.projectId),
    index("project_user_permission_user_id_index").on(self.userId),
    uniqueIndex("project_user_permission_unique_index").on(self.projectId, self.userId, self.permission),
  ],
);

// ===== Project Secrets (encrypted at rest) =====

export const projectSecret = sqliteTable(
  "project_secret",
  {
    /** Encrypted value in format: keyId:base64(iv):base64(ciphertext) */
    ciphertext: text("ciphertext").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    id: text("id").primaryKey(),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    /** Logical name of the secret (e.g. PAYMENT_API_KEY) */
    name: text("name").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (self) => [
    index("project_secret_project_id_index").on(self.projectId),
    uniqueIndex("project_secret_project_name_unique_index").on(self.projectId, self.name),
  ],
);

// ===== Audit Logging =====

export const auditLog = sqliteTable(
  "audit_log",
  {
    action: text("action").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    id: text("id").primaryKey(),
    metadata: text("metadata", { mode: "json" })
      .$defaultFn(() => ({}))
      .$type<Metadata>(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    resourceId: text("resource_id"),
    resourceType: text("resource_type"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (self) => [
    index("audit_log_user_id_index").on(self.userId),
    index("audit_log_organization_id_index").on(self.organizationId),
    index("audit_log_project_id_index").on(self.projectId),
    index("audit_log_resource_index").on(self.resourceType, self.resourceId),
    index("audit_log_created_at_index").on(self.createdAt),
  ],
);
