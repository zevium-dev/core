import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import * as schema from "./schema";

// Helper for metadata field that can be JSON string or object
export const MetadataZod = z
  .record(z.string(), z.unknown())
  .or(
    z
      .string()
      .transform((val) => JSON.parse(val))
      .pipe(z.record(z.string(), z.unknown())),
  )
  .nullable();

export type Metadata = z.infer<typeof MetadataZod>;

export const UserSelectZod = createSelectSchema(schema.user);
export const UserInsertZod = createInsertSchema(schema.user);

export const SessionSelectZod = createSelectSchema(schema.session);
export const SessionInsertZod = createInsertSchema(schema.session);

export const AccountSelectZod = createSelectSchema(schema.account);
export const AccountInsertZod = createInsertSchema(schema.account);

export const VerificationSelectZod = createSelectSchema(schema.verification);
export const VerificationInsertZod = createInsertSchema(schema.verification);

export const ApiKeySelectZod = createSelectSchema(schema.apikey).extend({ metadata: MetadataZod });
export const ApiKeyInsertZod = createInsertSchema(schema.apikey).extend({ metadata: MetadataZod });

export const TwoFactorSelectZod = createSelectSchema(schema.twoFactor);
export const TwoFactorInsertZod = createInsertSchema(schema.twoFactor);

export const OrganizationSelectZod = createSelectSchema(schema.organization).extend({ metadata: MetadataZod });
export const OrganizationInsertZod = createInsertSchema(schema.organization).extend({ metadata: MetadataZod });

export const MemberSelectZod = createSelectSchema(schema.member);
export const MemberInsertZod = createInsertSchema(schema.member);

export const InvitationSelectZod = createSelectSchema(schema.invitation);
export const InvitationInsertZod = createInsertSchema(schema.invitation);

const VariablesZod = z
  .array(z.object({ name: z.string(), value: z.string() }))
  .or(
    z
      .string()
      .transform((val) => JSON.parse(val))
      .pipe(z.array(z.object({ name: z.string(), value: z.string() }))),
  )
  .nullable();

export const ProjectSelectZod = createSelectSchema(schema.project).extend({
  metadata: MetadataZod,
  variables: VariablesZod,
});
export const ProjectInsertZod = createInsertSchema(schema.project).extend({
  metadata: MetadataZod,
  variables: VariablesZod,
});

export const TagSelectZod = createSelectSchema(schema.tag).extend({ metadata: MetadataZod });
export const TagInsertZod = createInsertSchema(schema.tag).extend({ metadata: MetadataZod });

export const ProjectTagSelectZod = createSelectSchema(schema.projectTag);
export const ProjectTagInsertZod = createInsertSchema(schema.projectTag);

export const OrganizationTagSelectZod = createSelectSchema(schema.organizationTag);
export const OrganizationTagInsertZod = createInsertSchema(schema.organizationTag);

export const OpenAPISchemaSelectZod = createSelectSchema(schema.openAPISchema).extend({ metadata: MetadataZod });
export const OpenAPISchemaInsertZod = createInsertSchema(schema.openAPISchema).extend({ metadata: MetadataZod });

export const OpenAPISchemaVersionSelectZod = createSelectSchema(schema.openAPISchemaVersion);
export const OpenAPISchemaVersionInsertZod = createInsertSchema(schema.openAPISchemaVersion);

export const UserPreferenceSelectZod = createSelectSchema(schema.userPreference);
export const UserPreferenceInsertZod = createInsertSchema(schema.userPreference);

export const UserPermissionSelectZod = createSelectSchema(schema.userPermission);
export const UserPermissionInsertZod = createInsertSchema(schema.userPermission);

export const OrganizationUserPermissionSelectZod = createSelectSchema(schema.organizationUserPermission);
export const OrganizationUserPermissionInsertZod = createInsertSchema(schema.organizationUserPermission);

export const ProjectUserPermissionSelectZod = createSelectSchema(schema.projectUserPermission);
export const ProjectUserPermissionInsertZod = createInsertSchema(schema.projectUserPermission);

export const ProjectSecretSelectZod = createSelectSchema(schema.projectSecret).extend({
  metadata: MetadataZod,
});
export const ProjectSecretInsertZod = createInsertSchema(schema.projectSecret).extend({
  metadata: MetadataZod,
});
