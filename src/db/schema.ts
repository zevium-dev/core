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

export const organization = sqliteTable("organization", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  description: text("description"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const project = sqliteTable("project", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  description: text("description"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const api = sqliteTable("api", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  description: text("description"),
  documentation: text("documentation"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  openApiSpec: text("openapi_spec"),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["active", "deprecated", "beta"] })
    .$defaultFn(() => "active")
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  version: text("version").notNull(),
});

export const apiPricing = sqliteTable("api_pricing", {
  apiId: text("api_id")
    .notNull()
    .references(() => api.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  currency: text("currency").$defaultFn(() => "USD").notNull(),
  id: text("id").primaryKey(),
  price: integer("price").notNull(), // stored in cents
  tier: text("tier").notNull(), // e.g., "basic", "pro", "enterprise"
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const projectMember = sqliteTable("project_member", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "admin", "editor", "viewer"] })
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});
