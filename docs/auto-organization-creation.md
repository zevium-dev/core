# Automatic Default Organization Creation

This feature automatically creates a default organization for new users when they log in for the first time. This ensures every user has an organization to work with immediately after signing up.

## How it works

### 1. Organization Service (`src/lib/server/organization-service.ts`)

This service provides the core functionality:

- `createDefaultOrganization()`: Creates a default organization with standard settings
- `userHasOrganizations()`: Checks if a user already has any organizations
- `generateUniqueSlug()`: Ensures organization slugs are unique

### 2. Organization RPC (`src/server/rpcs/organization/index.ts`)

Provides TRPC endpoints:

- `ensureDefaultOrganization`: Main endpoint that checks and creates organization if needed
- `hasOrganizations`: Check if user has organizations
- `createDefault`: Create default organization (will fail if user already has organizations)

### 3. Client Hook (`src/hooks/use-ensure-default-organization.ts`)

Provides React hooks and components:

- `useEnsureDefaultOrganization()`: Hook that automatically creates organizations
- `AutoCreateDefaultOrganization`: Component that runs the hook automatically

### 4. Integration (`src/components/providers.tsx`)

The `AutoCreateDefaultOrganization` component is included in the main app providers, ensuring it runs automatically when users log in.

## Default Organization Settings

New organizations are created with:

- **Name**: `{UserName}'s Organization`
- **Slug**: Auto-generated from user name/email (with uniqueness checks)
- **Owner**: The new user (with full admin permissions)
- **Settings**:
  - `defaultProjectVisibility`: "private"
  - `allowMemberProjectCreation`: true
  - `requireInviteApproval`: false
- **User Role**: "owner" with full permissions

## Flow

1. User signs up/logs in
2. `AutoCreateDefaultOrganization` component checks if user has organizations
3. If no organizations exist, creates a default one automatically
4. User can immediately start using the platform with their default organization
5. User can later create additional organizations or modify the default one

## Seamless Experience

- No additional input required from user
- Happens automatically during login
- Fails gracefully (won't break auth flow)
- Only creates organization once per user
- User becomes the owner/admin of their default organization

## API Endpoints

The organization endpoints are available at:

- `POST /api/trpc/organization.ensureDefaultOrganization` - Main endpoint
- `GET /api/trpc/organization.hasOrganizations` - Check user organizations
- `POST /api/trpc/organization.createDefault` - Force create (fails if exists)
