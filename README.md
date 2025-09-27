# [zevium.dev](https://zevium.dev)

This repo has all the code for my site [zevium.dev](https://zevium.dev).
The entire website was made using TanStack Start.

![TanStack Start](https://img.shields.io/badge/TanStack%20Start-0-c93679?style=for-the-badge&logo=zap)
![shadcn](https://img.shields.io/badge/shadcnui-4-ffffff?style=for-the-badge&logo=shadcnui)
![TypeScript](https://img.shields.io/badge/TypeScript-5-4476c0?style=for-the-badge&logo=typescript)
![PNPM](https://img.shields.io/badge/pnpm-9-f69220?style=for-the-badge&logo=pnpm)

![Drizzle](https://img.shields.io/badge/Drizzle-ORM-ffffff?style=for-the-badge&logo=drizzle)
![Turso](https://img.shields.io/badge/Turso-Database-ffffff?style=for-the-badge&logo=turso)
![Workers](https://img.shields.io/badge/Cloudflare-Workers-ffffff?style=for-the-badge&logo=cloudflare)
![Mise](https://img.shields.io/badge/Mise-2025-ffffff?style=for-the-badge&logo=misskey)

---

## Instructions

### Manual Setup

- You can start the dev server using the following commands:

```sh
# Install `mise` CLI
curl https://mise.run | sh # Install `mise` CLI
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Install tools
mise trust
mise install
npm i -g pnpm

# Add .env file
cp .env.example .env
vim .env

# Install dependencies
pnpm install

# Setup DB
pnpm drizzle-kit migrate

# Start the dev server
pnpm dev
```

- Open `http://localhost:5173` in your browser to view the website.

---

## Docs

### Framework

- [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview): Core client and server framework.

### UI

- [shadcn/ui](https://ui.shadcn.com/docs): UI framework.
- [Tailwind CSS](https://tailwindcss.com/docs/styling-with-utility-classes): Styling.

### Backend

- [tRPC](https://trpc.io/docs/quickstart): App server framework.
- [Better Auth](https://www.better-auth.com/docs/introduction): Authentication.

### Data

- [Drizzle ORM](https://orm.drizzle.team/docs/get-started): Database ORM.
- [Turso (libSQL)](https://docs.turso.tech/libsql): Database (subject to change).
