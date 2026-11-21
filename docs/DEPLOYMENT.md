# Deployment

How to put AI Workforce OS on the internet. Two options: **A** (managed services, least upkeep) or **B** (one VPS,
cheapest). Pick one.

## What runs where

| Piece | Needs | Why |
|---|---|---|
| Dashboard (`apps/dashboard`, Next.js 16) | Any Next.js host | Plain web app. |
| API (`apps/api`, Fastify) | A server that **stays running** and allows **WebSockets** | Phone calls hold a WebSocket for the whole call; the workflow runner runs inside the process. Serverless (Vercel functions, Lambda) will not work. |
| PostgreSQL 17 | The **pgvector** extension | Knowledge search uses vectors. |
| Inngest | Inngest Cloud account | Durable background jobs (memory learning, WhatsApp/email answers, workflow sleeps). |
| Clerk | A **production** instance | Sign-in. Needs your own domain. |
| Redis | Not needed | Nothing in the code uses it yet. |

Requirements: Node **22.18 or newer** (the API runs TypeScript directly), pnpm **10.32.1**.

## Before you start

1. **Fix the API start script.** `apps/api/package.json` has `"start": "node --env-file=../../.env src/server.ts"`.
   Node refuses to start when that file is missing, and hosts give variables directly, not as a file. Either change it
   to `node --env-file-if-exists=../../.env src/server.ts` or use `node src/server.ts` as the start command on the host.
2. **Buy or pick a domain**, e.g. `yourdomain.com`. You will use:
   - `app.yourdomain.com` for the dashboard
   - `api.yourdomain.com` for the API
3. **Generate the credentials key** (seals organizations' provider keys; keep it safe, losing it loses every saved
   connection):
   ```bash
   openssl rand -base64 32
   ```

---

## Option A: managed services

Dashboard on Vercel, API on Railway (Render or Fly.io work the same way), database on Neon (or Supabase, or Railway
Postgres).

### 1. Database

1. Create a Postgres database on Neon. pgvector is available there; the migrations enable it.
2. Copy the connection string. That is `DATABASE_URL`.
3. Apply the migrations from your machine:
   ```bash
   DATABASE_URL="<the connection string>" pnpm --filter @workforce/database exec prisma migrate deploy
   ```
   Run this again after every release that adds a migration (`packages/database/prisma/migrations`).

### 2. Clerk

1. In the Clerk dashboard, create a **production** instance and add your domain.
2. Add the DNS records Clerk shows.
3. Turn on Organizations (the app relies on them).
4. Copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (they start with `pk_live_` / `sk_live_`).

### 3. API on Railway

1. New project, deploy from the GitHub repo.
2. Settings:
   - Root directory: repository root (the API imports the workspace packages)
   - Build command: `pnpm install --frozen-lockfile && pnpm db:generate`
   - Start command: `cd apps/api && node src/server.ts`
   - Node version: 22.18+ (set `NIXPACKS_NODE_VERSION=22` or an `engines` aware builder)
3. Add a custom domain: `api.yourdomain.com`.
4. Set the environment variables (see [Environment variables](#environment-variables)).
5. Deploy. Check `https://api.yourdomain.com` answers.

### 4. Dashboard on Vercel

1. Import the GitHub repo.
2. Root directory: `apps/dashboard`. Vercel detects Next.js and pnpm.
3. Environment variables:
   - `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
4. Add the domain `app.yourdomain.com`.
5. Deploy.

### 5. Inngest

1. Create an Inngest Cloud account and app.
2. Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` on the API. Do **not** set `INNGEST_DEV` in production.
3. In Inngest, sync the app at `https://api.yourdomain.com/api/inngest`.
4. Check that 5 functions appear.

---

## Option B: one VPS

One server (Hetzner, DigitalOcean; 2 vCPU / 4 GB is enough to start) running everything with Docker Compose and
Caddy for HTTPS. You handle updates, backups and uptime yourself.

1. Create the server (Ubuntu), install Docker and Node 22.18+ with pnpm (`corepack enable`).
2. Point `app.yourdomain.com` and `api.yourdomain.com` (A records) at the server's IP.
3. Clone the repo, create `.env` from `.env.example` with production values (see below).
4. Start Postgres with pgvector. Use the repo's `docker-compose.yml` but **change the password** and **remove the
   public port** (`ports: ["5432:5432"]`) so the database is not reachable from the internet:
   ```bash
   docker compose up -d postgres
   ```
5. Install, migrate, build:
   ```bash
   pnpm install --frozen-lockfile
   pnpm db:generate
   pnpm --filter @workforce/database exec prisma migrate deploy
   pnpm --filter @workforce/dashboard build
   ```
6. Run the API and dashboard as services that restart on crash and boot, e.g. with pm2:
   ```bash
   npm i -g pm2
   pm2 start "pnpm --filter @workforce/api start" --name api
   pm2 start "pnpm --filter @workforce/dashboard start" --name dashboard
   pm2 save && pm2 startup
   ```
7. Install Caddy and use this `Caddyfile` (HTTPS certificates are automatic; WebSockets pass through):
   ```
   app.yourdomain.com {
     reverse_proxy localhost:3000
   }
   api.yourdomain.com {
     reverse_proxy localhost:4000
   }
   ```
8. Set up Inngest as in Option A step 5.
9. **Backups:** schedule a daily `pg_dump` to off-server storage. Without it a disk failure loses all data.

---

## Environment variables

Names are in `.env.example`. Production values:

**Required**

| Variable | Value |
|---|---|
| `DATABASE_URL` | Production Postgres connection string |
| `API_PORT` | Port the host expects (Railway sets `PORT`; map it, or use 4000 on a VPS) |
| `DASHBOARD_ORIGIN` | `https://app.yourdomain.com` (CORS: the API only accepts the dashboard from here) |
| `PUBLIC_URL` | `https://api.yourdomain.com` (used in webhook and call stream URLs) |
| `NEXT_PUBLIC_API_URL` | `https://api.yourdomain.com` (dashboard) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk production keys |
| `AI_CREDENTIALS_KEY` | The key generated above |
| `AI_PROVIDER`, `AI_MODEL`, `OPENROUTER_API_KEY` | The platform's default AI model |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` | Knowledge embeddings |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | From Inngest Cloud |

**Only for features you use**

| Feature | Variables |
|---|---|
| Phone calls | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` or `TELNYX_*`; `DEEPGRAM_API_KEY`; `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`; `VOICE_NUMBER` |
| WhatsApp (Meta) | `META_WHATSAPP_ACCESS_TOKEN`, `META_APP_SECRET`, `META_WHATSAPP_VERIFY_TOKEN` |
| Email | `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` |
| Other AI providers | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ... |

Organizations can also connect their own providers in Settings; those keys are stored sealed in the database, not in
these variables.

Never commit `.env`. Set variables in the host's dashboard.

## Webhooks

After the API is live, enter these URLs in each provider's console (replace the base with your `PUBLIC_URL`):

| Provider | URL |
|---|---|
| Twilio / Telnyx voice: incoming call | `https://api.yourdomain.com/voice/twilio/inbound` (or `/voice/telnyx/inbound`) |
| Twilio / Telnyx voice: status callback | `https://api.yourdomain.com/voice/twilio/status` (or `/voice/telnyx/status`) |
| WhatsApp (Meta): callback URL and verify token | `https://api.yourdomain.com/channels/whatsapp/meta/webhook` with `META_WHATSAPP_VERIFY_TOKEN` |
| WhatsApp (Twilio / Telnyx) | `https://api.yourdomain.com/channels/whatsapp/twilio/webhook` (or `/telnyx/`) |
| Inngest | `https://api.yourdomain.com/api/inngest` |

Organizations' own phone, WhatsApp and Resend connections show their webhook URLs in Settings.

## Check after deploying

1. Open `https://app.yourdomain.com`, sign up, create an organization.
2. Create an AI employee, publish it, send a test chat message: a reply means the API, database and AI key work.
3. Upload a small PDF to Knowledge; it should reach "Ready" (embeddings and storage work).
4. Send a test chat with a customer, then open Customers: the customer and their memories appear (Inngest works).
5. If you use phone calls: call `VOICE_NUMBER` and talk to the employee.
6. Watch the API logs for errors during all of the above.

## Updating

1. Push to `main`.
2. Option A: Railway and Vercel redeploy on their own. Option B: `git pull`, `pnpm install`, rebuild the dashboard,
   `pm2 restart all`.
3. If the release added a migration, run `prisma migrate deploy` (step 1.3) **before** the new API starts.

## Scaling later

Run one API instance until you need more. With two or more, some limits are kept per process (Test Connection rate
limit in `apps/api/src/providers/routes.ts`, model cooldowns in `packages/ai-provider/src/router.ts`); move them to
Redis first.
