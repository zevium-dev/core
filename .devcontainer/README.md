# Development Container Configuration

This directory contains the development container configuration for the Zevium.dev project.

## What's Included

### Base Environment

- **Node.js 22.12.0** (specified in `mise.toml`)
- **Ubuntu/Debian** base with development tools
- **mise** for tool version management
- **pnpm** package manager

### VS Code Extensions

- **ESLint** - Code linting and formatting
- **Prettier** - Code formatting
- **Tailwind CSS IntelliSense** - Tailwind utility classes support
- **TypeScript** - Enhanced TypeScript support
- **MDX** - MDX file support
- **Error Lens** - Inline error display
- **Todo Tree** - TODO comment highlighting
- **Path Intellisense** - File path autocompletion

### Port Forwarding

- **5173** - Development server (Vite)
- **4173** - Preview server

## Quick Start

### Using VS Code

1. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Open the repository in VS Code
3. When prompted, click "Reopen in Container" or use `Ctrl+Shift+P` → "Dev Containers: Reopen in Container"
4. Wait for the container to build and setup to complete
5. Run `pnpm dev` to start the development server

### Using GitHub Codespaces

1. Create a new Codespace from the repository
2. The devcontainer will automatically set up the environment
3. Run `pnpm dev` to start the development server

## What Happens During Setup

The `setup.sh` script automatically:

1. ✅ Configures `mise` tool manager
2. ✅ Installs Node.js 22.12.0 via mise
3. ✅ Installs `pnpm` package manager globally
4. ✅ Copies `.env.example` to `.env`
5. ✅ Installs all project dependencies
6. ✅ Runs type checking to verify setup

## Environment Variables

The setup process creates a `.env` file from `.env.example`. You'll need to update it with actual values:

```bash
# Database
LIBSQL_URL=your_turso_database_url
LIBSQL_SECRET=your_turso_auth_token

# Authentication
AUTH_GOOGLE_CLIENT_ID=your_google_client_id
AUTH_GOOGLE_CLIENT_SECRET=your_google_client_secret

# Optional services
VITE_PUBLIC_POSTHOG_KEY=your_posthog_key
AUTUMN_SECRET_KEY=your_autumn_secret
RESEND_API_KEY=your_resend_api_key
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token
```

## Available Commands

| Command          | Description                                      |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | Start development server                         |
| `pnpm build`     | Build for production                             |
| `pnpm lint`      | Run ESLint                                       |
| `pnpm typecheck` | Run TypeScript compiler                          |
| `pnpm ci`        | Run all checks (typecheck + lint + format:check) |
| `pnpm format`    | Format code with Prettier and ESLint             |

## Customization

### Adding Extensions

Edit `.devcontainer/devcontainer.json` and add extension IDs to the `extensions` array:

```json
"extensions": [
  "existing.extension",
  "new.extension.id"
]
```

### Modifying VS Code Settings

Edit the `settings` object in `.devcontainer/devcontainer.json`:

```json
"settings": {
  "existing.setting": "value",
  "new.setting": "new-value"
}
```

### Adding Features

The devcontainer uses [Features](https://containers.dev/features) for additional functionality. Add them to the `features` object:

```json
"features": {
  "ghcr.io/devcontainers-contrib/features/mise:2": {},
  "ghcr.io/devcontainers/features/docker-in-docker:2": {}
}
```

## Troubleshooting

### Container Won't Start

- Check Docker is running
- Try rebuilding: `Ctrl+Shift+P` → "Dev Containers: Rebuild Container"

### Missing Tools

- The `mise` feature should handle tool installation
- Check `mise.toml` for configured tools
- Manually run `mise install` in the terminal

### Port Already in Use

- Change the port in `vite.config.ts` or `package.json`
- Update `forwardPorts` in `devcontainer.json`

### Environment Variables

- Ensure `.env` file exists and contains required values
- Check the `.env.example` file for reference
- Restart the dev server after updating environment variables

## Development Workflow

1. **Start the container** - VS Code will handle this automatically
2. **Update environment variables** - Edit `.env` with your actual values
3. **Start development** - Run `pnpm dev`
4. **Code with confidence** - Linting, formatting, and type checking are configured
5. **Test changes** - Use `pnpm ci` to run all checks before committing

The container provides a consistent, reproducible development environment that matches the project requirements exactly.
