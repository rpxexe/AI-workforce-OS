# AI Workforce OS

SaaS for building and managing AI employees. Built phase by phase from prompts the owner pastes in.
pnpm monorepo: `apps/api` (Fastify), `apps/dashboard` (Next.js 16), `packages/*`, `workers/*`.

**Start here instead of exploring the repo:**

- [docs/STATUS.md](docs/STATUS.md): which phases are done, what is open. Read first. Update it when a phase ends.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): structure, data model, auth, API routes, dashboard patterns.
- [docs/DECISIONS.md](docs/DECISIONS.md): why things are the way they are, and traps already hit.

## Commands

```bash
pnpm dev          # API :4000 + dashboard :3000
pnpm typecheck    # root tsc + dashboard
pnpm lint
pnpm test         # API tests; need the database running
pnpm db:migrate   # prisma migrate dev + generate
pnpm inngest:dev  # Inngest dev server for durable background jobs (with INNGEST_DEV=1)
```

## Rules that are easy to break

- Code outside the dashboard runs on Node directly (type stripping): no enums or parameter
  properties, and relative imports end in `.ts`.
- Every tenant query filters on `organizationId` (and `workspaceId`) taken from the verified
  session via `guards()` in `apps/api/src/auth.ts`. Never take an organization id from the request.
- Employee versions are immutable. Saving inserts a version; only publishing moves the live pointer.
- After changing `schema.prisma`, run `pnpm db:generate` (Prisma 7 does not do it on migrate).
- Do not read `.env`; a hook blocks it. Variable names are in `.env.example`.
- On Windows run `pnpm add` from the repo root with `--filter`, or from a `D:\` (upper-case) path.
- Read `apps/dashboard/AGENTS.md` before writing Next.js code: version 16 differs from older ones.
- Only build what the current phase asks for. Later-phase features stay as placeholders.
- UI is shadcn/ui only. Every shadcn component is installed in `apps/dashboard/src/components/ui/`;
  check there before writing any markup, and build every dashboard component from it
  (bordered boxes: Card/Item, notices: Alert, empty views: Empty, bars: Progress/Chart,
  spinners: Spinner, filters: ToggleGroup, hints: Tooltip, show/hide: Collapsible).
  Reuse `EmptyState`, `ErrorState`, `LoadingState`, `StatTile` from `components/states.tsx`.
  If a primitive is missing, add it with `pnpm dlx shadcn@latest add <name>` (run in
  `apps/dashboard`). Never hand-write a replacement, use raw `<button>`/`<input>`/`<select>`/
  `<label>`/`<table>`, or add another UI library (MUI, Chakra, Headless UI, etc.).
  Icons: lucide-react only. Styling: Tailwind plus the theme tokens in `globals.css`
  (incl. `success`, `warning`, `info`, `chart-1..5`); no hard-coded colors.
