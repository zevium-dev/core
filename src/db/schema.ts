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

// ===== Captcha =====

export const captchaChallenge = sqliteTable("captcha_challenge", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  data: text("data", { mode: "json" }).notNull(),
  expires: integer("expires", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  token: text("token").notNull().primaryKey(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export const captchaToken = sqliteTable("captcha_token", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  expires: integer("expires", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  key: text("key").notNull().primaryKey(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
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
