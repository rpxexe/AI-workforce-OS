# Deployment on Cloudflare

How to host AI Workforce OS with Cloudflare. Read [DEPLOYMENT.md](DEPLOYMENT.md) first: environment variables,
webhooks, Clerk, Inngest and the checks after deploying are the same and are not repeated here.

## What Cloudflare can and cannot run

| Piece | On Cloudflare? | Use |
|---|---|---|
| DNS, HTTPS, CDN, firewall | Yes | Cloudflare in front of everything |
| Dashboard (Next.js 16) | Yes, with the OpenNext adapter (`@opennextjs/cloudflare`) on Workers | Or keep it on Vercel |
| API (Fastify) | **Not on Workers** | A VPS reached through **Cloudflare Tunnel** |
| Knowledge file storage | Yes: **R2** | Already supported (Settings > Storage) |
| PostgreSQL + pgvector | **No** (D1 is SQLite, not Postgres) | Neon, Supabase, or Postgres on the VPS |
| Background jobs | No | Inngest Cloud |

Why the API cannot run on Workers: it is a long-running Node server. It holds WebSockets for whole phone calls, runs the
workflow runner on a timer inside the process, uses Prisma with a direct Postgres connection, and uses Node modules
(`net`, `tls`, SMTP, undici agents) that Workers do not fully provide. Porting it would be a rewrite.

Recommended layout:

```
app.yourdomain.com  -> Cloudflare Workers (dashboard, OpenNext)     or Vercel
api.yourdomain.com  -> Cloudflare Tunnel -> VPS running the API (port 4000)
database            -> Neon (pgvector)                              or Postgres on the VPS
files               -> Cloudflare R2
jobs                -> Inngest Cloud
```

## 1. Put the domain on Cloudflare

1. Add your domain in the Cloudflare dashboard (free plan is enough).
2. Change the nameservers at your registrar to the two Cloudflare shows.
3. SSL/TLS mode: **Full (strict)**.
4. Network: make sure **WebSockets** is on (it is by default).

## 2. API on a VPS behind Cloudflare Tunnel

The tunnel connects out from the server to Cloudflare, so the server needs no open ports and its IP stays hidden.

1. Set up the VPS as in [DEPLOYMENT.md, Option B](DEPLOYMENT.md#option-b-one-vps) steps 1 and 3-6 (skip Caddy: the
   tunnel handles HTTPS). Run only the API there if the dashboard goes on Workers.
2. Install `cloudflared` on the VPS ([Cloudflare's install guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
3. Create the tunnel and route the hostname:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create workforce-api
   cloudflared tunnel route dns workforce-api api.yourdomain.com
   ```
4. Create `/etc/cloudflared/config.yml`:
   ```yaml
   tunnel: workforce-api
   credentials-file: /root/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: api.yourdomain.com
       service: http://localhost:4000
     - service: http_status:404
   ```
5. Run it as a service:
   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   ```
6. Check `https://api.yourdomain.com` answers.
7. Close the firewall to everything except SSH (`ufw allow OpenSSH && ufw enable`). Postgres must not be public.

Set on the API: `PUBLIC_URL=https://api.yourdomain.com`, `DASHBOARD_ORIGIN=https://app.yourdomain.com`.

## 3. Dashboard on Cloudflare Workers

**Check first:** the dashboard uses Next.js 16 and Clerk. Confirm on the
[OpenNext Cloudflare docs](https://opennext.js.org/cloudflare) that your Next.js version is supported before
starting. If it is not, put the dashboard on Vercel ([DEPLOYMENT.md, Option A step 4](DEPLOYMENT.md#4-dashboard-on-vercel))
and keep everything else here.

1. Add the adapter and Wrangler to the dashboard (from the repo root, Windows note in `CLAUDE.md`):
   ```bash
   pnpm add --filter @workforce/dashboard @opennextjs/cloudflare
   pnpm add --filter @workforce/dashboard -D wrangler
   ```
2. Create `apps/dashboard/wrangler.jsonc`:
   ```jsonc
   {
     "name": "workforce-dashboard",
     "main": ".open-next/worker.js",
     "compatibility_date": "2025-09-01",
     "compatibility_flags": ["nodejs_compat"],
     "assets": { "directory": ".open-next/assets", "binding": "ASSETS" }
   }
   ```
3. Create `apps/dashboard/open-next.config.ts`:
   ```ts
   import { defineCloudflareConfig } from "@opennextjs/cloudflare";
   export default defineCloudflareConfig();
   ```
4. Add scripts to `apps/dashboard/package.json`:
   ```json
   "preview:cf": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
   "deploy:cf": "opennextjs-cloudflare build && opennextjs-cloudflare deploy"
   ```
5. Set the variables. `NEXT_PUBLIC_*` are baked in at build time, so they must be set where the build runs:
   - `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY` as a secret: `pnpm --filter @workforce/dashboard exec wrangler secret put CLERK_SECRET_KEY`
6. Try it locally with `pnpm --filter @workforce/dashboard preview:cf`, sign in, open a few pages.
7. Deploy: `pnpm --filter @workforce/dashboard deploy:cf`.
8. In Workers > your worker > Settings > Domains, add `app.yourdomain.com`.

To deploy on every push instead, connect the repo in Workers Builds with root directory `apps/dashboard`, build command
`pnpm opennextjs-cloudflare build`, deploy command `pnpm opennextjs-cloudflare deploy`.

## 4. Knowledge files on R2

1. Cloudflare dashboard > R2 > create a bucket, e.g. `workforce-knowledge`.
2. R2 > Manage API tokens > create a token with Object Read & Write on that bucket. Note the Access Key ID, Secret
   Access Key and the account's S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`).
3. In the app: Settings > Storage > connect **Cloudflare R2** with those values, press Test Connection, set it as
   default. New uploads go to R2; older files stay where they were.

## 5. Database and jobs

- Database: Neon as in [DEPLOYMENT.md, Option A step 1](DEPLOYMENT.md#1-database), or Postgres on the VPS (Option B
  step 4). Run `prisma migrate deploy` either way.
- Inngest: [DEPLOYMENT.md, Option A step 5](DEPLOYMENT.md#5-inngest), syncing `https://api.yourdomain.com/api/inngest`.

## Cloudflare settings that can break things

- **Response timeout (100 s on non-Enterprise plans).** A request that sends nothing for 100 seconds is cut with a 524.
  Streamed chat replies send as they go and phone-call WebSockets carry audio constantly, so normal use is fine. A
  stalled model call longer than that would fail.
- **Bot Fight Mode / "Under Attack" mode** can challenge provider webhooks (Twilio, Meta, Telnyx, Resend, Inngest)
  that cannot solve a challenge. Leave them off for `api.yourdomain.com`, or add a WAF skip rule for `/voice/*`,
  `/channels/*`, `/hooks/*`, `/chat/*` and `/api/inngest`.
- **Caching:** do not add cache rules for `api.yourdomain.com`. API answers are per user and must not be cached.
- **Rocket Loader / auto minify:** keep off for the dashboard; they can break the Next.js scripts.
- **Client IPs:** behind Cloudflare the API sees Cloudflare's address; the visitor's is in `CF-Connecting-IP`.

## Webhooks and checks

Enter the webhook URLs from [DEPLOYMENT.md, Webhooks](DEPLOYMENT.md#webhooks), then run the checks in
[DEPLOYMENT.md, Check after deploying](DEPLOYMENT.md#check-after-deploying).
