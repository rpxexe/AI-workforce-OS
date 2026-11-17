# Architecture

## Layout

```
apps/api          Fastify 5 + WebSocket, port 4000. Runs TypeScript directly on Node 24.
apps/dashboard    Next.js 16 (App Router), Tailwind 4, shadcn/ui (radix-nova), Clerk. Port 3000.
packages/database Prisma 7 schema, migrations, generated client, exported `prisma`.
packages/shared   Zod schemas and types used by both API and dashboard.
packages/ai-provider   `AIProvider` interface, `providerFromEnv()`, OpenRouter (default) and Anthropic.
packages/agent-runtime `runTurn()`: context builder, provider call, timeout, conversation storage.
packages/knowledge     Parsing, chunking, embedding and vector search (`processDocument`, `retrieve`).
packages/*        stt, tts, telephony, tools, memory, workflows: empty stubs.
workers/*         agent-worker, call-worker, evaluation-worker: empty stubs.
```

Packages are named `@workforce/<name>` and export TypeScript source from `src/index.ts`; there is
no build step. One `.env` at the repo root is read by the API (`--env-file`), Prisma
(`prisma.config.ts`) and the dashboard (`next.config.ts`).

## Data model (`packages/database/prisma/schema.prisma`)

- `Organization`: `id` is the Clerk organization id. Created lazily on the organization's first
  `GET /workspaces`, together with a "Default" workspace.
- `Workspace`: belongs to an organization; name unique per organization.
- `AiEmployee` (table `AIEmployee`): `organizationId`, `workspaceId`, `status`
  (DRAFT, ACTIVE, PAUSED, ARCHIVED), `publishedVersionId` (the live version, nullable).
- `AiEmployeeVersion` (table `AIEmployeeVersion`): immutable config snapshot, `number` unique per
  employee. Fields: name, description, role, personality, systemInstructions, goals (text[]),
  language, avatar, workingHours (JSON), escalation (JSON).

- `Conversation`: `organizationId`, `workspaceId`, `employeeId`, `channel` ("test" so far), `title`.
- `ConversationMessage`: `role` (USER, ASSISTANT), `content`; assistant rows also carry
  `employeeVersion`, `provider`, `model`, `inputTokens`, `outputTokens`, `latencyMs`.
  `sources` (the knowledge documents and pages the reply was given).
- `KnowledgeSource`: a named collection of documents in a workspace; name unique per workspace.
- `KnowledgeDocument`: the uploaded file (`content` bytes, kept for reprocessing), `kind`
  (pdf, docx, txt, csv), `status` (PENDING, PROCESSING, READY, FAILED), `error`, `chunkCount`.
- `KnowledgeChunk`: a passage of a document (`index`, `page` for PDFs, `content`). Documents and
  chunks repeat `organizationId`, `workspaceId` and `sourceId` so searches filter on them directly.
- `Embedding`: one per chunk; `model` and a pgvector `vector(1536)`. Prisma cannot read or write
  that column, so only `packages/knowledge` touches it, with SQL.
- `EmployeeKnowledgeSource`: which sources an employee answers from.

Deleting an organization cascades to everything under it. Clerk owns users, members and roles;
we store only Clerk user ids (`createdBy`).

## Auth and authorization (`apps/api/src/auth.ts`)

- The API registers `@clerk/fastify`; the dashboard sends the Clerk session token as a Bearer token.
- `guards(authenticate)` gives three helpers used by every tenant route:
  - `member(req)`: 401 if signed out, 403 if no organization is active.
  - `admin(req)`: also 403 unless the role is `org:admin`.
  - `inWorkspace(auth, workspaceId)`: 404 unless the workspace belongs to the caller's organization.
- Members read; admins write. Anything outside the caller's organization or workspace answers 404.
- `buildApp({ authenticate })` lets tests inject identities (`apps/api/src/testing.ts`); the real
  server always uses Clerk.

## API routes

```
GET   /health                                   public
GET   /ws                                       WebSocket echo (placeholder transport)
GET   /workspaces                               member; provisions org + Default on first call
POST  /workspaces                               admin
GET   /workspaces/:workspaceId/employees        member; ?archived=true for the archived list
POST  /workspaces/:workspaceId/employees        admin; creates employee + version 1
GET   /workspaces/:workspaceId/employees/:id    member; includes all versions, newest first
PUT   /workspaces/:workspaceId/employees/:id    admin; appends a new version
POST  .../employees/:id/publish                 admin; body { version }; first publish activates
PATCH .../employees/:id/status                  admin; ACTIVE | PAUSED | ARCHIVED
POST  .../employees/:id/duplicate               admin; new draft from the latest version
GET   .../employees/:id/conversations           member; newest 50
GET   .../employees/:id/conversations/:cid      member; with messages
POST  .../employees/:id/messages                admin; body { conversationId?, message }; SSE reply
GET   .../employees/:id/knowledge               member; sources attached to the employee
PUT   .../employees/:id/knowledge               admin; body { sourceIds }; replaces the set
GET   /workspaces/:workspaceId/knowledge/sources            member
POST  .../knowledge/sources                     admin; body { name, description? }
GET   .../knowledge/sources/:sourceId           member; with documents and their status
DELETE .../knowledge/sources/:sourceId          admin; removes documents, chunks, attachments
POST  .../knowledge/sources/:sourceId/documents?name=       admin; the file is the request body
                                                (application/octet-stream, 10 MB limit)
DELETE .../knowledge/documents/:documentId      admin
POST  .../knowledge/documents/:documentId/reprocess         admin
POST  .../knowledge/search                      member; body { query, sourceIds? }
```

## Knowledge and retrieval

```
upload -> KnowledgeDocument (PENDING) -> processDocument(), in the background:
  parse.ts   text per file type (unpdf for PDF, by page; mammoth for DOCX; CSV keeps its header)
  chunk.ts   passages of up to 1200 characters with 150 of overlap; CSV chunks are whole rows
  embedder   EmbeddingProvider.embed(), 64 passages per call
  one transaction replaces the document's chunks and embeddings -> READY (or FAILED + reason)

question -> retrieve(): embed the question, cosine search in pgvector, filtered by
            organizationId, workspaceId, the given source ids, and the embedding model
```

- The dashboard polls a source every 2 seconds while a document is PENDING or PROCESSING.
- `runTurn` calls `retrieve` with the employee's attached sources before building the context;
  the passages go into the system prompt, and the documents and pages they came from are saved
  on the reply as `sources` and shown under it in the test chat.
- `EmbeddingProvider` lives in `packages/ai-provider` beside `AIProvider`: `embeddingProviderFromEnv()`,
  chosen by `EMBEDDING_PROVIDER`. `EMBEDDING_DIMENSIONS` (1536) must match the database column.

## Agent runtime

```
API route (conversations.ts): authorize, pick the employee version, open the SSE stream
  -> runTurn() in @workforce/agent-runtime
       -> buildContext(): system prompt from the employee config + last 40 messages + new message
       -> AIProvider.stream(): text chunks, then token usage
       -> saves the user message and the reply together; yields text | done | error events
```

- Every channel must go through `runTurn`; it is the only code that calls a provider or writes
  conversation rows. The caller authorizes first and passes tenant ids the runtime trusts.
- A turn that fails, times out (`AI_TIMEOUT_MS`) or is cancelled by the browser saves nothing.
- Providers live in `packages/ai-provider/src`, registered in `PROVIDERS` in `index.ts` and chosen
  by `AI_PROVIDER`. `openai-compatible.ts` serves any OpenAI-style endpoint (OpenRouter uses it);
  `anthropic.ts` uses the Anthropic SDK. They throw only `AIProviderError` (kind: config, auth,
  billing, rate_limit, refused, unavailable, invalid); the runtime maps each kind to a message safe to show.
- The stream is server-sent events carrying `ChatStreamEvent` (`packages/shared/src/conversation.ts`).
  Requests are refused with a normal JSON error before the stream opens; after that, failures
  arrive as an `error` event on a 200 response.

Request bodies are validated with the Zod schemas in `packages/shared/src/employee.ts` and
`workspace.ts`. Errors are `{ error, issues? }` (`ApiError`); validation failures are 400 with
`issues[].path` matching form field paths.

## Dashboard

- `src/proxy.ts`: Clerk middleware; every route except `/sign-in` and `/sign-up` needs a session.
- `src/app/layout.tsx`: `ClerkProvider` inside `<Suspense>` (required with `cacheComponents`).
- `src/app/(auth)/`: sign-in and sign-up pages. `src/app/(app)/`: everything else, inside `AppShell`.
- `src/components/app-shell.tsx`: sidebar, organization switcher, workspace switcher, user button.
  Shows "Choose an organization" when none is active.
- `src/lib/api.ts`: `useApi()` (authenticated fetch), `useApiQuery(path)` (load, reload, setData)
  and `useApiStream()` (POST that reads server-sent events).
- `src/app/(app)/employees/[id]/chat/page.tsx`: test chat, opened from the employee page.
- `src/app/(app)/knowledge/`: sources list with search, and `[sourceId]` for documents (upload,
  status, reprocess, delete). `components/employees/employee-knowledge.tsx` attaches sources.
- `src/lib/workspace.tsx`: `WorkspaceProvider`, `useWorkspaces()`, `useIsAdmin()`, and
  `withWorkspace(Page)`, which every workspace-dependent page is wrapped in.
- `src/components/states.tsx`: `PageHeader`, `LoadingState`, `ErrorState`, `EmptyState`, `ComingSoon`.
- `src/components/employees/`: `employee-form.tsx` (create and edit), `meta.tsx` (avatar, status badge).
- Pages are client components that fetch from the API; there are no server-side data fetches.

## Tests

`apps/api/src/*.test.ts` use `node:test` against the real database with throwaway organization
ids, cleaned up afterwards. Conversation tests inject a fake `AIProvider` through
`buildApp({ provider, embedder, aiTimeoutMs })`; knowledge tests upload the sample files in
`apps/api/src/fixtures`. There are no dashboard tests in the repo.
