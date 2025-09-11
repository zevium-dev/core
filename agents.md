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

## Getting Started for Agents

To work effectively with this codebase:

1. **Understand the stack**: Familiarize yourself with TanStack Start, tRPC, and Drizzle ORM
2. **Study the routing**: File-based routing in `src/routes/`
3. **Explore components**: shadcn/ui components in `src/components/ui/`
4. **Review schemas**: Database schema in `src/db/schema.ts`
5. **Check APIs**: tRPC procedures in `src/server/rpcs/`
6. **Mock data**: Understanding features through `src/lib/utils/mockdata.ts`

The codebase follows modern React patterns with strong TypeScript integration, making it maintainable and scalable for future development.
