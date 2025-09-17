import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable("session", {
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  ipAddress: text("ip_address"),
  token: text("token").notNull().unique(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  accessToken: text("access_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  accountId: text("account_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  idToken: text("id_token"),
  password: text("password"),
  providerId: text("provider_id").notNull(),
  refreshToken: text("refresh_token"),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
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

export const cache = sqliteTable("cache", {
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => /* @__PURE__ */ new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  key: text("key").notNull().unique().primaryKey(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => /* @__PURE__ */ new Date()),
  value: text("value").notNull(),
});

export const apikey = sqliteTable("apikey", {
  id: text("id").primaryKey(),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: integer("last_refill_at", { mode: "timestamp" }),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(
    true,
  ),
  rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
  rateLimitMax: integer("rate_limit_max").default(10),
  requestCount: integer("request_count").default(0),
  remaining: integer("remaining"),
  lastRequest: integer("last_request", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  permissions: text("permissions"),
  metadata: text("metadata"),
});

// ===== ORGANIZATION SCHEMA =====

export const organization = sqliteTable("organization", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  description: text("description"),
  id: text("id").primaryKey(),
  logo: text("logo"), // URL to organization logo
  name: text("name").notNull(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }), // Organization owner cannot be deleted
  settings: text("settings", { mode: "json" }).$defaultFn(() => ({})), // JSON field for extensible settings
  slug: text("slug").notNull().unique(), // For URL-friendly organization identification
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  website: text("website"),
});

export const organizationMember = sqliteTable("organization_member", {
  id: text("id").primaryKey(),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  joinedAt: integer("joined_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  permissions: text("permissions", { mode: "json" }).$defaultFn(() => ({})), // Extensible permissions
  role: text("role", { enum: ["owner", "admin", "member"] })
    .notNull()
    .$defaultFn(() => "member"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

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
  weight: integer("weight").$defaultFn(() => 0), // For custom ordering in UI
});

export const projectMember = sqliteTable("project_member", {
  addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
  id: text("id").primaryKey(),
  joinedAt: integer("joined_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  permissions: text("permissions", { mode: "json" }).$defaultFn(() => ({})), // Project-specific permissions
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

export const organizationInvitation = sqliteTable("organization_invitation", {
  acceptedAt: integer("accepted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  email: text("email").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  id: text("id").primaryKey(),
  invitedBy: text("invited_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["admin", "member"] })
    .notNull()
    .$defaultFn(() => "member"),
  token: text("token").notNull().unique(), // Secure invitation token
});

// ===== API SPEC SCHEMA =====

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
  security: text("security", { mode: "json" }).$defaultFn(() => []), // Security requirements array
  specId: text("spec_id")
    .notNull()
    .references(() => apiSpec.id, { onDelete: "cascade" }),
  summary: text("summary"),
  tags: text("tags", { mode: "json" }).$defaultFn(() => []), // Array of tag strings
});

// ===== RELATIONS =====

export const userRelations = relations(user, ({ many }) => ({
  createdProjects: many(project),
  organizationMemberships: many(organizationMember),
  ownedOrganizations: many(organization),
  projectMemberships: many(projectMember),
  sentInvitations: many(organizationInvitation),
}));

export const organizationRelations = relations(organization, ({ many, one }) => ({
  invitations: many(organizationInvitation),
  members: many(organizationMember),
  owner: one(user, {
    fields: [organization.ownerId],
    references: [user.id],
  }),
  projects: many(project),
}));

export const organizationMemberRelations = relations(organizationMember, ({ one }) => ({
  inviter: one(user, {
    fields: [organizationMember.invitedBy],
    references: [user.id],
  }),
  organization: one(organization, {
    fields: [organizationMember.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [organizationMember.userId],
    references: [user.id],
  }),
}));

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

export const organizationInvitationRelations = relations(organizationInvitation, ({ one }) => ({
  inviter: one(user, {
    fields: [organizationInvitation.invitedBy],
    references: [user.id],
  }),
  organization: one(organization, {
    fields: [organizationInvitation.organizationId],
    references: [organization.id],
  }),
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
