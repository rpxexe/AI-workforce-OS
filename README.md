# AI Workforce OS

SaaS for building and managing AI employees that talk to customers by phone, WhatsApp, web chat and
email. pnpm monorepo, TypeScript throughout.

Phase status and open items: [docs/STATUS.md](docs/STATUS.md). Structure, data model and routes:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Why things are the way they are: [docs/DECISIONS.md](docs/DECISIONS.md).

## What is built

- **Accounts**: sign-in, organizations, workspaces and roles (Clerk).
- **AI employees** with immutable versions; publishing picks the live version.
- **Agent runtime** on OpenRouter (default) or Anthropic, with streamed test chat.
- **Knowledge base**: PDF, DOCX, TXT and CSV upload, pgvector search, cited sources.
- **Customer memory**: facts and conversation summaries, recalled in later conversations on any channel.
- **Tools**: calendar, email, HTTP request and webhook, with per-employee grants and an audit log.
- **Voice**: inbound and outbound calls (Twilio or Telnyx), Deepgram speech-to-text, ElevenLabs speech, barge-in.
- **Workflows**: visual journey builder (React Flow), 12 node types, versions, runs with retry.
- **Channels**: WhatsApp (Meta, Twilio or Telnyx), embeddable web chat widget, email through Resend.
- **Background jobs** on Inngest, or in the API process when Inngest is not configured.

Not built yet: human handoff in conversations, analytics, billing, and the Customers, Conversations and
Analytics dashboard pages (placeholders). See STATUS.md for the full list.

```
apps/dashboard   Next.js 16 + Tailwind + shadcn/ui     http://localhost:3000
apps/api         Fastify + WebSocket                   http://localhost:4000
packages/        database (Prisma), shared, ai-provider, agent-runtime, knowledge, memory,
                 tools, stt, tts, telephony, workflows, channels
workers/         stubs for later phases
```

## Setup

Needs Node 22.18+ (the API runs TypeScript directly on Node), pnpm 10, Docker, a Clerk application
with **Organizations enabled** (https://dashboard.clerk.com) and an OpenRouter API key.

```bash
cp .env.example .env   # fill in the Clerk keys and OPENROUTER_API_KEY
pnpm install
pnpm infra:up          # PostgreSQL (pgvector image) + Redis
pnpm db:migrate        # apply migrations
pnpm dev               # API + dashboard
```

Sign up at http://localhost:3000, create an organization, and you land in its Default workspace.

Everything else in `.env.example` is optional and documented there:

| Feature | Variables |
|---|---|
| Phone calls | `TELNYX_*` or `TWILIO_*`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `VOICE_NUMBER`, `PUBLIC_URL` |
| WhatsApp | Twilio or Telnyx keys above, or `META_*`; `PUBLIC_URL` |
| Email | `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` (test mode without them) |
| Durable jobs | `INNGEST_DEV=1` with `pnpm inngest:dev` locally; `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` in production |

Webhooks from Twilio, Telnyx, Meta and Resend need a public URL. Locally, run `ngrok http 4000` and set
`PUBLIC_URL` to its address. To place a test call:

```bash
PUBLIC_URL=<ngrok url> CALL_TO=<your number> pnpm --filter @workforce/api try-call
```

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
pnpm test              # needs the database running; LIVE_AI=1 adds tests that call the real model
```

## Conventions

- One `.env` at the repo root. The API, Prisma and the dashboard all read it.
- Workspace packages are named `@workforce/<name>` and export TypeScript source from
  `src/index.ts`; there is no build step. Add a package to the dashboard's
  `transpilePackages` in `apps/dashboard/next.config.ts` when the dashboard imports it.
- Code outside the dashboard must use erasable TypeScript only (no enums or parameter
  properties) and `.ts` extensions on relative imports, because Node runs it directly.
- After changing `schema.prisma`, run `pnpm db:generate`; Prisma 7 does not do it on migrate.
- On Windows, run pnpm from a path with an upper-case drive letter (`D:\...`). pnpm 10
  crashes on `pnpm add` inside a package when the drive letter is lower-case.
