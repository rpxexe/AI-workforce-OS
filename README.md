# AI Workforce OS

Monorepo, pnpm workspaces, TypeScript throughout. Built so far: sign-in, organizations and
workspaces (Clerk), and AI Employee management with versioning.

```
apps/dashboard   Next.js + Tailwind + shadcn/ui        http://localhost:3000
apps/api         Fastify + WebSocket                   http://localhost:4000
packages/        database (Prisma), shared (types), and stubs for later phases
workers/         stubs for later phases
```

## Setup

Needs Node 22.18+ (the API runs TypeScript directly on Node), pnpm 10, Docker and a Clerk
application with **Organizations enabled** (https://dashboard.clerk.com).

```bash
cp .env.example .env   # then fill in the two Clerk keys
pnpm install
pnpm infra:up        # PostgreSQL (pgvector image) + Redis
pnpm db:migrate      # apply migrations
pnpm dev             # API + dashboard
```

Sign up at http://localhost:3000, create an organization, and you land in its Default workspace.

## How access works

- Clerk owns users, organizations, members and roles. The API takes the organization from the
  verified session, never from the request.
- Every row belongs to an organization and a workspace; anything outside the caller's own
  answers 404.
- Any member can read. Only organization admins (`org:admin`) can create or change things.
- An employee's configuration lives in immutable versions. Saving adds a version; publishing
  chooses which version is live.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test            # needs the database running
```

## Conventions

- One `.env` at the repo root. The API, Prisma and the dashboard all read it.
- Workspace packages are named `@workforce/<name>` and export TypeScript source from
  `src/index.ts`; there is no build step. Add a package to the dashboard's
  `transpilePackages` in `apps/dashboard/next.config.ts` when the dashboard imports it.
- Code outside the dashboard must use erasable TypeScript only (no enums or parameter
  properties) and `.ts` extensions on relative imports, because Node runs it directly.
- On Windows, run pnpm from a path with an upper-case drive letter (`D:\...`). pnpm 10
  crashes on `pnpm add` inside a package when the drive letter is lower-case.
