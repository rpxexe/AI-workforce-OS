# Status

Last updated: 2026-11-17, after Phase 4.

## Phases

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo foundation, tooling, database connection | Done |
| 1 | Clerk auth, organizations, workspaces, roles, dashboard shell | Built; real sign-in flow not yet confirmed by a person |
| 2 | AI Employee CRUD with versioning | Built; verified with Clerk stubbed |
| 3 | Agent runtime, AI provider abstraction (OpenRouter default, Anthropic), conversations, test chat | Built; a real OpenRouter reply confirmed through the API, chat page not yet tried in a browser |
| 4 | Knowledge base and RAG: sources, PDF/DOCX/TXT/CSV upload, pgvector search, retrieval in the runtime, source tracing | Built; confirmed end to end through the API with real OpenRouter models, dashboard pages not yet tried in a browser |
| 5+ | Not started | Owner pastes the next phase prompt |

## Open items

- **Clerk Organizations is disabled** in the owner's Clerk application ("AI Workforce", development
  instance). The app cannot get past "Choose an organization" until it is enabled in the Clerk dashboard.
- **Real signed-in flow untested**: sign-up, creating and switching organizations, and the
  dashboard calling the API with a real session token. Keys are in `.env` and both servers start.
- **Test chat and Knowledge pages not exercised in a browser**; they typecheck, lint and build.
- **Nothing is committed** to git yet.

## Verified so far

- `pnpm typecheck`, `pnpm lint`, dashboard production build: pass.
- Docker Postgres and Redis run via `pnpm infra:up`; all three migrations are applied there.
- 26 API tests against the Docker Postgres (`pnpm test`). Knowledge (5, with fake models): all four
  file types processed, search ranks the answering passage first with document and page, the
  runtime gives attached knowledge to the model and stores the reply's sources, bad files fail
  with a reason, reprocess replaces chunks, delete, role checks, organization and workspace isolation. OpenRouter provider (2, against a local
  stand-in server): streaming, usage, error kinds. Conversations (5, with a fake provider):
  streaming, saved messages and usage, history on later turns, latest version used, provider
  failure and timeout save nothing, validation, role checks, isolation. Employees and workspaces (14): CRUD, versioning, validation, role checks (members get 403
  on writes), isolation (other organization or workspace gets 404 on every route), cascade delete.
- `LIVE_AI=1 pnpm test` adds two tests that call the provider configured in `.env` (skipped
  otherwise, since it spends money). They passed against OpenRouter: a plain reply, and the
  pricing example (upload `fixtures/pricing.pdf`, attach it, ask "What is the enterprise plan
  price?"; the reply said $499 per month and cited pricing.pdf page 2).
- With real Clerk keys: API returns 401 when signed out; dashboard pages redirect to `/sign-in`;
  the Clerk sign-in form renders.
- 18-step headless-browser walkthrough of the signed-in UI (desktop and mobile) with Clerk stubbed.

## Deliberately not built yet

Voice, WhatsApp, web chat, email, memory, tools, workflows, human handoff
(escalation settings are stored but the runtime does not act on them, nor on working hours),
analytics, billing, model routing. In the dashboard, Customers, Conversations,
Workflows and Analytics are placeholder pages. Packages other than `database`, `shared`,
`ai-provider`, `agent-runtime` and `knowledge`, and
all three workers, are empty stubs.

Also skipped, small: scanned PDFs (no OCR), a queue for document processing (it runs inside the
API process), a vector index (search is exact), a relevance floor on retrieved passages, renaming
knowledge sources, embedding providers other than OpenRouter, providers other than OpenRouter and Anthropic, summarizing long conversations (the runtime
sends the last 40 messages), deleting or renaming conversations, workspace rename/delete, hard delete of employees, list pagination (capped
at 200 per workspace), avatar image upload (icons only), mirroring Clerk users into our database.

Not installed: Inngest, Cloudflare R2, React Flow, a Redis client, Prettier, Turborepo.

