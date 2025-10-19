import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

type Base64String = {} & string;

export const user = sqliteTable("user", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
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
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable("session", {
  activeOrganizationId: text("active_organization_id").references(() => organization.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  ipAddress: text("ip_address"),
  token: text("token").notNull().unique(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  accessToken: text("access_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  accountId: text("account_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
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
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const verification = sqliteTable("verification", {
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => /* @__PURE__ */ new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => /* @__PURE__ */ new Date()),
  value: text("value").notNull(),
});

// ===== API Keys =====

export const apikey = sqliteTable("apikey", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  lastRefillAt: integer("last_refill_at", { mode: "timestamp" }),
  lastRequest: integer("last_request", { mode: "timestamp" }),
  metadata: text("metadata", { mode: "json" }).$defaultFn(() => ({})),
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
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// === Two-Factor Authentication =====

export const twoFactor = sqliteTable("two_factor", {
  backupCodes: text("backup_codes").notNull(),
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// ===== Organizations =====

export const organization = sqliteTable("organization", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  id: text("id").primaryKey(),
  logo: text("logo").$type<Base64String>(),
  metadata: text("metadata", { mode: "json" }).$defaultFn(() => ({})),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
});

export const member = sqliteTable("member", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member", "admin", "guest"] })
    .notNull()
    .$defaultFn(() => "member"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const invitation = sqliteTable("invitation", {
  email: text("email").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member", "admin", "guest"] })
    .notNull()
    .$defaultFn(() => "member"),
  status: text("status").default("pending").notNull(),
});

// ===== Other =====

export const project = sqliteTable("project", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  description: text("description"),
  id: text("id").primaryKey(),
  metadata: text("metadata", { mode: "json" }).$defaultFn(() => ({})), // API specs, documentation, etc.
  name: text("name").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  projectCategoryId: text("project_category_id").references(() => projectCategory.id, { onDelete: "set null" }),
  settings: text("settings", { mode: "json" }).$defaultFn(() => ({})), // Project-specific settings
  slug: text("slug").notNull(), // Unique within organization
  status: text("status", { enum: ["active", "inactive", "archived", "beta", "deprecated"] })
    .notNull()
    .$defaultFn(() => "active"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  visibility: text("visibility", { enum: ["public", "private", "internal"] })
    .notNull()
    .$defaultFn(() => "private"),
});

export const projectCategory = sqliteTable("project_category", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  description: text("description"),
  icon: text("icon"), // Icon name or emoji for UI display
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  weight: integer("weight")
    .$defaultFn(() => 0)
    .notNull(), // For custom ordering in UI
});

export const projectMember = sqliteTable("project_member", {
  addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
  id: text("id").primaryKey(),
  joinedAt: integer("joined_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  permissions: text("permissions", { mode: "json" })
    .$defaultFn(() => ({}))
    .notNull(), // Project-specific permissions
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["admin", "editor", "viewer"] })
    .notNull()
    .$defaultFn(() => "viewer"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const apiSpec = sqliteTable("api_spec", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  format: text("format", { enum: ["json", "yaml"] }).notNull(),
  hash: text("hash").notNull().unique(), // SHA256 of normalized JSON to prevent duplicates
  id: text("id").primaryKey(),
  originalRaw: text("original_raw"), // Original uploaded text (YAML/JSON)
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  specJson: text("spec_json", { mode: "json" }).notNull(), // Normalized JSON object
  status: text("status", { enum: ["active", "deprecated", "archived"] })
    .$defaultFn(() => "active")
    .notNull(),
  title: text("title"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  versionLabel: text("version_label").notNull(), // e.g. "v1", "2025-09-05"
});

export const apiEndpoint = sqliteTable("api_endpoint", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  deprecated: integer("deprecated", { mode: "boolean" })
    .$defaultFn(() => false)
    .notNull(),
  id: text("id").primaryKey(),
  method: text("method").notNull(), // GET, POST, PUT, DELETE, etc.
  operationId: text("operation_id"),
  path: text("path").notNull(),
  security: text("security", { mode: "json" })
    .$defaultFn(() => [])
    .notNull(), // Security requirements array
  specId: text("spec_id")
    .notNull()
    .references(() => apiSpec.id, { onDelete: "cascade" }),
  summary: text("summary"),
  tags: text("tags", { mode: "json" })
    .$defaultFn(() => [])
    .notNull(), // Array of tag strings
});

export const projectRelations = relations(project, ({ many, one }) => ({
  apiSpecs: many(apiSpec),
  category: one(projectCategory, {
    fields: [project.projectCategoryId],
    references: [projectCategory.id],
  }),
  creator: one(user, {
    fields: [project.createdBy],
    references: [user.id],
  }),
  members: many(projectMember),
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
}));

export const projectMemberRelations = relations(projectMember, ({ one }) => ({
  adder: one(user, {
    fields: [projectMember.addedBy],
    references: [user.id],
  }),
  project: one(project, {
    fields: [projectMember.projectId],
    references: [project.id],
  }),
  user: one(user, {
    fields: [projectMember.userId],
    references: [user.id],
  }),
}));

export const projectCategoryRelations = relations(projectCategory, ({ many }) => ({
  projects: many(project),
}));

export const apiSpecRelations = relations(apiSpec, ({ many, one }) => ({
  endpoints: many(apiEndpoint),
  project: one(project, {
    fields: [apiSpec.projectId],
    references: [project.id],
  }),
}));

export const apiEndpointRelations = relations(apiEndpoint, ({ one }) => ({
  spec: one(apiSpec, {
    fields: [apiEndpoint.specId],
    references: [apiSpec.id],
  }),
}));

// ===== User Preferences (1:1) =====

export const userPreference = sqliteTable("user_preference", {
  timezone: text("timezone").notNull().default("UTC"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  // primary key also FK to user
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const userPreferenceRelations = relations(userPreference, ({ one }) => ({
  user: one(user, {
    fields: [userPreference.userId],
    references: [user.id],
  }),
}));
