# Agents.md - Zevium.dev Repository Overview

## Project Description

**Zevium.dev** is a modern API management and integration platform built with cutting-edge web technologies. The platform serves as an API hub that allows developers to manage, monitor, and integrate various APIs for their projects. It features project management, organization management, API documentation, and collaborative team features.

## Technology Stack

### Core Framework

- **TanStack Start**: Full-stack React framework with SSR/SSG capabilities
- **React 19.1.1**: Latest React with server components and concurrent features
- **TypeScript 5.8.3**: Strongly typed development
- **Vite**: Build tool with hot module replacement

### Backend & APIs

- **tRPC 11.4.4**: End-to-end typesafe APIs with automatic client generation
- **ORPC**: OpenAPI integration and documentation generation
- **Better Auth 1.3.4**: Modern authentication with Google OAuth
- **Drizzle ORM 0.44.4**: Type-safe database ORM

### Database

- **Turso (libSQL)**: Distributed SQLite-compatible database
- **Drizzle Kit**: Database migrations and schema management

### Styling & UI

- **Tailwind CSS 4.1.11**: Utility-first CSS framework with latest features
- **shadcn/ui**: High-quality component library built on Radix UI
- **Radix UI**: Accessible, unstyled component primitives
- **Motion**: Animation library for smooth interactions
- **Lucide React**: Beautiful icon library

### State Management & Data Fetching

- **TanStack Query**: Server state management and caching
- **Jotai**: Atomic state management for client state
- **Zod**: Runtime type validation and schema parsing

### Development & Deployment

- **Cloudflare Workers**: Serverless edge deployment
- **Wrangler**: Cloudflare development and deployment tool
- **PNPM**: Fast, disk space efficient package manager
- **ESLint**: Code linting with modern configuration
- **Prettier**: Code formatting

### Analytics & Monitoring

- **PostHog**: Product analytics and feature flags
- **Sonner**: Toast notifications

## Project Architecture

### Directory Structure

```text
src/
├── components/           # React components
│   ├── ui/              # shadcn/ui components
│   ├── magicui/         # Enhanced UI components with animations
│   └── shared/          # Reusable business components
├── routes/              # TanStack Router file-based routing
│   ├── api/             # API routes
│   └── settings/        # Settings pages
├── server/              # Backend logic
│   ├── rpcs/            # tRPC procedures organized by feature
│   ├── context.ts       # Request context creation
│   └── orpc.tsx         # OpenAPI documentation generation
├── db/                  # Database schema and configuration
├── lib/                 # Utility libraries
│   ├── auth/            # Authentication client
│   ├── trpc/            # tRPC client configuration
│   └── utils/           # Helper functions and mock data
├── hooks/               # Custom React hooks
├── env/                 # Environment variable validation
└── styles/              # CSS files and styling
```

### Key Components

#### Authentication System

- **Better Auth** integration with Google OAuth
- Session management with JWT tokens
- Protected routes with automatic redirects
- User state management across the application

#### API Architecture

- **tRPC** for type-safe API procedures
- **ORPC** for OpenAPI specification generation
- Automatic documentation with Scalar API reference
- Error handling with proper HTTP status codes
- Input validation using Zod schemas

#### Database Layer

- **Drizzle ORM** with TypeScript-first approach
- **Turso** for distributed SQLite database
- Schema-first development with automatic migrations
- Relations and foreign keys properly defined

#### Frontend Features

- **File-based routing** with TanStack Router
- **Server-side rendering** with hydration
- **Component composition** with shadcn/ui
- **Responsive design** with mobile-first approach
- **Dark mode** support with theme persistence
- **Animations** using Motion library

#### UI Components

- **Project Cards**: Display API projects with stats and actions
- **Sidebar Navigation**: Collapsible navigation with user account management
- **Protected Routes**: Authentication-gated pages
- **File Upload**: Drag-and-drop file handling
- **Search & Filtering**: Project discovery features
- **Data Tables**: Sortable and filterable data display

## Core Features

### Project Management

- Create and manage API projects
- Organization-based project grouping
- Project statistics and analytics
- Team member management
- Project documentation upload

### API Integration

- OpenAPI specification support
- Automatic API documentation generation
- Interactive API explorer with Scalar
- Endpoint testing and monitoring
- Usage analytics and metrics

### User Management

- Google OAuth authentication
- User profiles and settings
- Organization membership
- Role-based access control
- Activity tracking

### Dashboard & Analytics

- Project overview dashboard
- Usage statistics and trends
- Revenue tracking (planned)
- Performance monitoring
- Real-time updates

## Development Workflow

### Local Development

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Configure environment variables

# Start development server
pnpm dev
```

### Code Formatting & Linting

When you encounter **ESLint warnings** or **formatting issues** in files:

```bash
# Format all files in the project
pnpm format
```

This command runs Prettier and ESLint fixes across the codebase to ensure:

- Consistent code formatting
- Automatic fixing of ESLint violations
- Adherence to project style guidelines

### Database Management

```bash
# Generate migrations
pnpm drizzle-kit generate

# Apply migrations
pnpm drizzle-kit migrate

# View database schema
pnpm drizzle-kit studio
```

### Deployment

- **Cloudflare Workers** for serverless edge deployment
- **GitHub Actions** for CI/CD (implied)
- **Environment variables** managed through Cloudflare
- **Asset optimization** with Vite build pipeline

## Environment Configuration

### Server Environment Variables

- `AUTH_GOOGLE_CLIENT_ID`: Google OAuth client ID
- `AUTH_GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `LIBSQL_URL`: Turso database URL
- `LIBSQL_SECRET`: Turso database authentication token

### Client Environment Variables

- `VITE_PUBLIC_URL`: Application base URL
- `VITE_PUBLIC_POSTHOG_KEY`: PostHog analytics key (optional)

## Code Quality & Standards

### Code Organization

- **TypeScript-first** development approach
- **Functional components** with hooks
- **Component composition** over inheritance
- **Utility-first** CSS with Tailwind
- **Type-safe** API communication

### Development Standards

- **ESLint** with React and TypeScript rules
- **Prettier** for consistent code formatting
- **Conventional commits** (implied)
- **Component testing** (setup available)
- **Type checking** in CI/CD pipeline

### Performance Optimizations

- **Code splitting** with lazy loading
- **Image optimization** for static assets
- **Bundle analysis** and optimization
- **Edge caching** with Cloudflare
- **Component memoization** where appropriate

## Security Considerations

### Authentication

- **OAuth 2.0** with Google provider
- **JWT tokens** for session management
- **CSRF protection** built into framework
- **Secure cookie** configuration

### API Security

- **Input validation** with Zod schemas
- **Rate limiting** (Cloudflare level)
- **CORS configuration** for API endpoints
- **Environment variable** protection

## Future Enhancements

Based on the codebase structure and mock data, planned features include:

- **Payment processing** integration
- **API marketplace** functionality
- **Advanced analytics** and reporting
- **Team collaboration** features
- **API versioning** management
- **Webhook management**
- **Custom domain** support
- **Enterprise features**

## Contribution Guidelines

These rules exist so contributions stay consistent, type-safe, minimal, and easily maintainable.

### 1. General Principles

- Prefer composition over duplication
- Minimize side-effects; colocate network logic in React Query / tRPC option objects
- Only fetch what is needed; defer persistence until explicit user intent (e.g. Save button)
- Never guess types — always import existing Zod schemas / inferred types
- Favor idempotent server mutations and optimistic UI where safe
- Keep client state (form drafts) separate from server state (queries)
- Avoid stale reads: invalidate after mutation (unless mutation result is authoritative)

### 2. React Query + tRPC Usage

DO NOT manually build `queryKey` arrays unless absolutely necessary. Use the generated helpers:

```ts
import { useTRPC } from "~/lib/trpc";

export const useUserPreferencesQuery = () => {
  const trpc = useTRPC();
  return useQuery(trpc.userPreference.get.queryOptions(undefined));
};

export const useUserPreferencesOptimisticMutation = () => {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(
    trpc.userPreference.update.mutationOptions({
      onMutate(variables) {
        qc.setQueryData(trpc.userPreference.get.queryKey(), (old) => ({ ...old, ...variables }));
      },
      async onSettled() {
        await qc.invalidateQueries(trpc.userPreference.get.queryOptions());
      },
    }),
  );
};
```

Rules:

- Split query and mutation hooks (no combined objects returning mixed state)
- Use `mutationOptions` / `queryOptions` from tRPC proxy when available
- For optimistic updates: `setQueryData` + post-settle `invalidateQueries`
- Do NOT trigger side-effects in the body of a hook outside React Query lifecycle callbacks
- **Do NOT add `onError` handlers** — a global default handler in `providers.tsx` already handles:
  - `TRPCClientError`: Shows error toast + logs to PostHog
  - `BetterAuthException`: Handles 429 rate limits, email verification redirects, and generic auth errors
  - Other errors: Generic error toast + logging
  - Only add `onError` if you need custom logic (redirect, conditional handling, etc.)
- **Make `onSuccess` async and always invalidate related queries**:
  - Use `useQueryClient()` to get the query client
  - In `onSuccess`, call `await queryClient.invalidateQueries(trpc.resource.list.queryOptions())` to refetch fresh data
  - This ensures UI stays in sync with server state after mutations
  - Example: After creating an org, invalidate the org list query so it refetches

### 3. Local Draft vs Server State

Pattern:

- Initialize local form state once (inside `useEffect`) only if the draft is still empty
- Do not persist on every change; batch on explicit action (e.g. Save)
- Compare against last known server values before deciding to mutate

### 4. Zod & Schemas

- Name exported schemas with PascalCase (`UserPreferenceZod`)
- Always reuse shared schemas for input & output where shape matches; avoid drift

### 5. Drizzle ORM Patterns

- Import from a _single_ barrel when available: `import { db, orm, schema } from "~/db"`
- Use `row = rows.at(0)` instead of index `[0]` to avoid undefined access pitfalls
- Use `returning()` + `.at(0)` after UPSERT operations instead of issuing follow-up selects
- Build `patch` object _only_ with provided fields

### 6. Mutation Design

- Mutations must be idempotent where feasible
- Return the canonical post-write state (or at least the changed subset)
- Let client optimistic layer hydrate instantly, then reconcile after invalidation

### 7. Naming Conventions

| Concern                  | Pattern                       |
| ------------------------ | ----------------------------- |
| Query hook               | `useThingQuery`               |
| Mutation hook            | `useThingMutation`            |
| Optimistic Mutation hook | `useThingOptimisticMutation`  |
| Form state vars          | `const [name, setName] = ...` |
| Boolean flags            | `isSaving`, `isPending`       |
| Zod schema               | `ThingZod`                    |
| Server router file       | `feature-name/index.ts`       |

### 8. Side-Effects

Only allowed via:

- React Query callbacks: `onSuccess`, `onError`, `onSettled`, `onMutate`
- Explicit user-intent handlers (e.g. button click)
  Avoid:
- `useEffect` that mirrors query data into state every render (only initialize when empty)
- Manual cache purges unless security-bound (e.g. on logout)

### 9. Conditional Enabling

Use `enabled: Boolean(dependency)` inside query options. Do not guard fetches with ternaries that render null early unless UX requires.

### 10. Error Handling

- Let React Query surface errors; map to toast/UI at call site
- Avoid swallowing errors in mutations; rethrow after logging if needed
- Never return `{ error: ... }` objects; throw instead

### 11. Form

Follow react-hook-form's best practices.

### 14. Returning Values from Mutations

Return exactly what the UI needs for reconciliation (e.g. updated fragment). Avoid large payloads.

### 15. Prevent Over-Fetching

- Prefer invalidation over refetch inside mutation `onSuccess`, unless the mutation response is incomplete

### 16. Examples of Anti-Patterns (Avoid)

| Anti-Pattern                                                  | Better                          |
| ------------------------------------------------------------- | ------------------------------- |
| Combined query + mutation hook returning many unrelated flags | Separate focused hooks          |
| Re-selecting row after insert/update                          | Use `.returning()`              |
| Index `[0]` access                                            | `.at(0)`                        |
| Immediate persistence on every select change                  | Local draft + explicit save     |
| Manual array query keys                                       | `trpc.entity.action.queryKey()` |

### 18. Commit Guidance

- Group schema + router + hook changes logically
- Include migration when altering DB schema
- Keep diff surface minimal; remove dead code instead of commenting it

### 19. Security & Data Hygiene

- Never trust client-provided identifiers when auth context supplies them
- Validate all mutation inputs with Zod schema at boundary
- Avoid leaking internal errors; map to generic messages if security-sensitive

### 20. When Unsure

Prefer:

1. Reuse existing pattern
2. Smaller, composable hook
3. Explicit state transitions

### 21. Theme & Styling

- **Never use hardcoded colors** from Tailwind (e.g., `bg-red-500`, `text-blue-600`, `rgb(239, 68, 68)`)
- Always use shadcn/ui theme-defined semantic colors instead:
  - For Tailwind classes: `bg-destructive`, `bg-primary`, `text-foreground`, etc.
  - For SVG/inline styles: `stroke="hsl(var(--destructive))"`, `fill="hsl(var(--primary))"`, etc.
  - With transparency: `stroke="hsl(var(--destructive) / 0.3)"` for 30% opacity
- Check available theme tokens in the design system (e.g., `--primary`, `--destructive`, `--secondary`, `--muted`, etc.)
- This ensures the component respects the design system and adapts to theme changes (e.g., dark mode)

---

### Quick Start Checklist for an AI Agent

1. Import existing schemas (do not redefine)
2. Use `useTRPC()` + generated `queryOptions` / `mutationOptions`
3. Add optimistic mutation only if merge is safe & deterministic
4. Invalidate post-settle
5. Keep UI update logic inside React Query callbacks
6. Return minimal object shapes
7. Use theme colors from shadcn/ui, never hardcoded Tailwind colors

Following these guidelines ensures generated code remains aligned with current best practices introduced in recent refactors (e.g. user preference handling).
