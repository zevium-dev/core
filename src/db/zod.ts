import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import * as schema from "./schema";

// Helper for metadata field that can be JSON string or object
const MetadataZod = z
  .record(z.string(), z.unknown())
  .or(
    z
      .string()
      .transform((val) => JSON.parse(val))
      .pipe(z.record(z.string(), z.unknown())),
  )
  .nullable();

// Select schemas (for reading from database)
export const UserSelectZod = createSelectSchema(schema.user);
export const SessionSelectZod = createSelectSchema(schema.session);
export const AccountSelectZod = createSelectSchema(schema.account);
export const VerificationSelectZod = createSelectSchema(schema.verification);
export const ApiKeySelectZod = createSelectSchema(schema.apikey);
export const TwoFactorSelectZod = createSelectSchema(schema.twoFactor);
export const OrganizationSelectZod = createSelectSchema(schema.organization).extend({
  metadata: MetadataZod,
});
export const MemberSelectZod = createSelectSchema(schema.member);
export const InvitationSelectZod = createSelectSchema(schema.invitation);
export const ProjectSelectZod = createSelectSchema(schema.project).extend({
  metadata: MetadataZod,
});
export const TagSelectZod = createSelectSchema(schema.tag).extend({
  metadata: MetadataZod,
});
export const ProjectTagSelectZod = createSelectSchema(schema.projectTag);
export const OrganizationTagSelectZod = createSelectSchema(schema.organizationTag);
export const OpenAPISchemaSelectZod = createSelectSchema(schema.openAPISchema).extend({
  metadata: MetadataZod,
});
export const OpenAPISchemaVersionSelectZod = createSelectSchema(schema.openAPISchemaVersion);
export const UserPreferenceSelectZod = createSelectSchema(schema.userPreference);

// Insert schemas (for creating records)
export const UserInsertZod = createInsertSchema(schema.user);
export const SessionInsertZod = createInsertSchema(schema.session);
export const AccountInsertZod = createInsertSchema(schema.account);
export const VerificationInsertZod = createInsertSchema(schema.verification);
export const ApiKeyInsertZod = createInsertSchema(schema.apikey).extend({
  metadata: MetadataZod,
});
export const TwoFactorInsertZod = createInsertSchema(schema.twoFactor);
export const OrganizationInsertZod = createInsertSchema(schema.organization).extend({
  metadata: MetadataZod,
});
export const MemberInsertZod = createInsertSchema(schema.member);
export const InvitationInsertZod = createInsertSchema(schema.invitation);
export const ProjectInsertZod = createInsertSchema(schema.project).extend({
  metadata: MetadataZod,
});

export const TagInsertZod = createInsertSchema(schema.tag).extend({
  metadata: MetadataZod,
});
export const ProjectTagInsertZod = createInsertSchema(schema.projectTag);
export const OrganizationTagInsertZod = createInsertSchema(schema.organizationTag);
export const OpenAPISchemaInsertZod = createInsertSchema(schema.openAPISchema).extend({
  metadata: MetadataZod,
});
export const OpenAPISchemaVersionInsertZod = createInsertSchema(schema.openAPISchemaVersion);
export const UserPreferenceInsertZod = createInsertSchema(schema.userPreference);

// Legacy aliases for backwards compatibility
export const UserZod = UserSelectZod;
export const SessionZod = SessionSelectZod;
export const AccountZod = AccountSelectZod;
export const VerificationZod = VerificationSelectZod;
export const ApiKeyZod = ApiKeySelectZod;
export const TwoFactorZod = TwoFactorSelectZod;
export const OrganizationZod = OrganizationSelectZod;
export const MemberZod = MemberSelectZod;
export const InvitationZod = InvitationSelectZod;
export const ProjectZod = ProjectSelectZod;
export const TagZod = TagSelectZod;
export const ProjectTagZod = ProjectTagSelectZod;
export const OrganizationTagZod = OrganizationTagSelectZod;
export const OpenAPISchemaZod = OpenAPISchemaSelectZod;
export const OpenAPISchemaVersionZod = OpenAPISchemaVersionSelectZod;
export const UserPreferenceZod = UserPreferenceSelectZod;
