import { db, orm, schema } from "~/db";

interface CreateDefaultOrganizationOptions {
  userEmail: string;
  userId: string;
  userName: string;
}

interface CreateOrganizationOptions {
  description?: string;
  name: string;
  userId: string;
  website?: string;
}

/**
 * Creates a default organization for a new user
 */
export async function createDefaultOrganization({ 
  userEmail,
  userId, 
  userName 
}: CreateDefaultOrganizationOptions) {
  const organizationId = crypto.randomUUID();
  const organizationMemberId = crypto.randomUUID();
  
  // Generate a unique slug based on the user's name or email
  const baseSlug = generateSlugFromName(userName || userEmail);
  const slug = await generateUniqueSlug(baseSlug);
  
  // Create the organization
  const organization = await db.insert(schema.organization).values({
    createdAt: new Date(),
    description: "Default organization created for new user",
    id: organizationId,
    name: `${userName}'s Organization`,
    ownerId: userId,
    settings: {
      allowMemberProjectCreation: true,
      defaultProjectVisibility: "private",
      requireInviteApproval: false,
    },
    slug: slug,
    updatedAt: new Date(),
  }).returning();

  // Add the user as the owner/admin of the organization
  await db.insert(schema.organizationMember).values({
    id: organizationMemberId,
    joinedAt: new Date(),
    organizationId: organizationId,
    permissions: {
      canDeleteOrganization: true,
      canInviteMembers: true,
      canManageProjects: true,
      canManageSettings: true,
      canRemoveMembers: true,
    },
    role: "owner",
    userId: userId,
  });

  return organization[0];
}

/**
 * Creates a new organization
 */
export async function createOrganization({ 
  description,
  name, 
  userId,
  website 
}: CreateOrganizationOptions) {
  const organizationId = crypto.randomUUID();
  const organizationMemberId = crypto.randomUUID();
  
  // Generate a unique slug based on the organization name
  const baseSlug = generateSlugFromName(name);
  const slug = await generateUniqueSlug(baseSlug);
  
  // Create the organization
  const organization = await db.insert(schema.organization).values({
    createdAt: new Date(),
    description: description ?? null,
    id: organizationId,
    name: name,
    ownerId: userId,
    settings: {
      allowMemberProjectCreation: true,
      defaultProjectVisibility: "private",
      requireInviteApproval: false,
    },
    slug: slug,
    updatedAt: new Date(),
    website: website ?? null,
  }).returning();

  // Add the user as the owner/admin of the organization
  await db.insert(schema.organizationMember).values({
    id: organizationMemberId,
    joinedAt: new Date(),
    organizationId: organizationId,
    permissions: {
      canDeleteOrganization: true,
      canInviteMembers: true,
      canManageProjects: true,
      canManageSettings: true,
      canRemoveMembers: true,
    },
    role: "owner",
    userId: userId,
  });

  // Get the organization with member and project counts
  const [memberCount, projectCount] = await Promise.all([
    db
      .select({ count: orm.count() })
      .from(schema.organizationMember)
      .where(orm.eq(schema.organizationMember.organizationId, organizationId)),
    db
      .select({ count: orm.count() })
      .from(schema.project)
      .where(orm.eq(schema.project.organizationId, organizationId)),
  ]);

  return {
    ...organization[0],
    memberCount: memberCount[0]?.count ?? 0,
    projectCount: projectCount[0]?.count ?? 0,
    settings: organization[0].settings as Record<string, unknown>,
  };
}

/**
 * Gets an organization by slug with member and project counts
 */
export async function getOrganizationBySlug(slug: string, userId: string) {
  // First get the organization
  const organization = await db
    .select({
      createdAt: schema.organization.createdAt,
      description: schema.organization.description,
      id: schema.organization.id,
      logo: schema.organization.logo,
      name: schema.organization.name,
      ownerId: schema.organization.ownerId,
      settings: schema.organization.settings,
      slug: schema.organization.slug,
      updatedAt: schema.organization.updatedAt,
      website: schema.organization.website,
    })
    .from(schema.organization)
    .where(orm.eq(schema.organization.slug, slug))
    .limit(1);

  if (organization.length === 0) {
    return null;
  }

  const org = organization[0];

  // Check if user is a member of this organization
  const membership = await db
    .select({
      id: schema.organizationMember.id,
      joinedAt: schema.organizationMember.joinedAt,
      permissions: schema.organizationMember.permissions,
      role: schema.organizationMember.role,
    })
    .from(schema.organizationMember)
    .where(
      orm.and(
        orm.eq(schema.organizationMember.organizationId, org.id),
        orm.eq(schema.organizationMember.userId, userId)
      )
    )
    .limit(1);

  if (membership.length === 0) {
    // User is not a member of this organization
    throw new Error("Access denied: You are not a member of this organization");
  }

  // Get member and project counts
  const [memberCount, projectCount] = await Promise.all([
    db
      .select({ count: orm.count() })
      .from(schema.organizationMember)
      .where(orm.eq(schema.organizationMember.organizationId, org.id)),
    db
      .select({ count: orm.count() })
      .from(schema.project)
      .where(orm.eq(schema.project.organizationId, org.id)),
  ]);

  return {
    ...org,
    memberCount: memberCount[0]?.count ?? 0,
    projectCount: projectCount[0]?.count ?? 0,
    settings: org.settings as Record<string, unknown>,
    userMembership: {
      ...membership[0],
      permissions: membership[0].permissions as Record<string, unknown>,
    },
  };
}

/**
 * Gets organization members with user details
 */
export async function getOrganizationMembers(organizationId: string, userId: string) {
  // Check if user is a member of this organization
  const membership = await db
    .select({ role: schema.organizationMember.role })
    .from(schema.organizationMember)
    .where(
      orm.and(
        orm.eq(schema.organizationMember.organizationId, organizationId),
        orm.eq(schema.organizationMember.userId, userId)
      )
    )
    .limit(1);

  if (membership.length === 0) {
    throw new Error("Access denied: You are not a member of this organization");
  }

  // Get all members with user details
  const members = await db
    .select({
      id: schema.organizationMember.id,
      joinedAt: schema.organizationMember.joinedAt,
      permissions: schema.organizationMember.permissions,
      role: schema.organizationMember.role,
      userEmail: schema.user.email,
      userId: schema.user.id,
      userImage: schema.user.image,
      userName: schema.user.name,
    })
    .from(schema.organizationMember)
    .innerJoin(schema.user, orm.eq(schema.organizationMember.userId, schema.user.id))
    .where(orm.eq(schema.organizationMember.organizationId, organizationId))
    .orderBy(orm.desc(schema.organizationMember.joinedAt));

  return members.map(member => ({
    ...member,
    permissions: member.permissions as Record<string, unknown>,
  }));
}

/**
 * Gets organization projects
 */
export async function getOrganizationProjects(organizationId: string, userId: string) {
  // Check if user is a member of this organization
  const membership = await db
    .select({ role: schema.organizationMember.role })
    .from(schema.organizationMember)
    .where(
      orm.and(
        orm.eq(schema.organizationMember.organizationId, organizationId),
        orm.eq(schema.organizationMember.userId, userId)
      )
    )
    .limit(1);

  if (membership.length === 0) {
    throw new Error("Access denied: You are not a member of this organization");
  }

  // Get all projects in the organization
  const projects = await db
    .select({
      createdAt: schema.project.createdAt,
      createdBy: schema.project.createdBy,
      creatorName: schema.user.name,
      description: schema.project.description,
      id: schema.project.id,
      metadata: schema.project.metadata,
      name: schema.project.name,
      settings: schema.project.settings,
      slug: schema.project.slug,
      status: schema.project.status,
      updatedAt: schema.project.updatedAt,
      visibility: schema.project.visibility,
    })
    .from(schema.project)
    .innerJoin(schema.user, orm.eq(schema.project.createdBy, schema.user.id))
    .where(orm.eq(schema.project.organizationId, organizationId))
    .orderBy(orm.desc(schema.project.updatedAt));

  return projects.map(project => ({
    ...project,
    metadata: project.metadata as Record<string, unknown>,
    settings: project.settings as Record<string, unknown>,
  }));
}

/**
 * Gets all organizations that a user has access to (either as owner or member)
 */
export async function getUserOrganizations(userId: string) {
  // Get organizations with member count and project count
  const organizations = await db
    .select({
      createdAt: schema.organization.createdAt,
      description: schema.organization.description,
      id: schema.organization.id,
      logo: schema.organization.logo,
      name: schema.organization.name,
      ownerId: schema.organization.ownerId,
      settings: schema.organization.settings,
      slug: schema.organization.slug,
      updatedAt: schema.organization.updatedAt,
      website: schema.organization.website,
    })
    .from(schema.organization)
    .innerJoin(
      schema.organizationMember,
      orm.eq(schema.organization.id, schema.organizationMember.organizationId)
    )
    .where(orm.eq(schema.organizationMember.userId, userId))
    .orderBy(orm.desc(schema.organization.updatedAt));

  // Get member counts for each organization
  const organizationsWithCounts = await Promise.all(
    organizations.map(async (org) => {
      const [memberCount, projectCount] = await Promise.all([
        db
          .select({ count: orm.count() })
          .from(schema.organizationMember)
          .where(orm.eq(schema.organizationMember.organizationId, org.id)),
        db
          .select({ count: orm.count() })
          .from(schema.project)
          .where(orm.eq(schema.project.organizationId, org.id)),
      ]);

      return {
        ...org,
        memberCount: memberCount[0]?.count ?? 0,
        projectCount: projectCount[0]?.count ?? 0,
        settings: org.settings as Record<string, unknown>,
      };
    })
  );

  return organizationsWithCounts;
}

/**
 * Checks if a user already has any organizations (either owned or member of)
 */
export async function userHasOrganizations(userId: string): Promise<boolean> {
  // Check if user owns any organizations
  const ownedOrgs = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(orm.eq(schema.organization.ownerId, userId))
    .limit(1);
  
  if (ownedOrgs.length > 0) {
    return true;
  }
  
  // Check if user is a member of any organizations
  const memberOrgs = await db
    .select({ id: schema.organizationMember.id })
    .from(schema.organizationMember)
    .where(orm.eq(schema.organizationMember.userId, userId))
    .limit(1);
  
  return memberOrgs.length > 0;
}

/**
 * Generates a URL-friendly slug from a name
 */
function generateSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .trim()
    .slice(0, 50) // Limit length
    || 'organization'; // Fallback if name is empty after processing
}

/**
 * Ensures the slug is unique by appending numbers if necessary
 */
async function generateUniqueSlug(baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let counter = 1;
  
  // Check if slug already exists
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const existing = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(orm.eq(schema.organization.slug, slug))
      .limit(1);
    
    if (existing.length === 0) {
      return slug;
    }
    
    // If slug exists, try with a number suffix
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
}
