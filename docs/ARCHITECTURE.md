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
packages/memory        Customer memory: `MemoryService` (`identify`, `recall`, `remember`), extraction + validation.
packages/tools         Tool system: registry, executor (permission, validation, timeout, retry, audit), the tools.
packages/telephony     `TelephonyProvider` and Twilio (REST, TwiML, webhook signatures, Media Streams messages).
packages/stt           `STTProvider` and Deepgram live transcription (turn detection, reconnects).
packages/tts           `TTSProvider` and ElevenLabs streaming speech (8 kHz mu-law).
packages/*        workflows: empty stub.
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
- `Customer`: a person employees talk to, in a workspace; `externalId` is what the channel knows
  them by (email, phone, visitor id), unique per workspace. `lastSeenAt`.
- `CustomerProfile`: one per customer; name, email, phone, company, copied from identity memories.
- `CustomerMemory`: one fact per `key` per customer (`category`: identity, preference, fact, lead,
  follow_up; `value`; `conversationId` where it was last learned). Learning a key again replaces it.
- `ToolPermission`: a tool granted to an employee (`employeeId` + `tool`), its admin `config`, and the
  tool's `permissions` at grant time. Not versioned.
- `ToolExecution`: the audit log, one row per tool call the model made: `status` (SUCCEEDED, FAILED,
  DENIED, INVALID), `input` as the model wrote it, `output` or `error`, `attempts`, `durationMs`,
  `conversationId`, `customerId`. `id` doubles as the idempotency key.
- `CalendarEvent`: the built-in calendar (per workspace) the booking tool writes to.
- `ConversationMessage.tools`: on replies, the tool calls made while writing them.
- `PhoneNumber`: a provider number (E.164, unique) answered by an employee, with its greeting.
- `Call`: one phone call: direction, status (QUEUED, RINGING, IN_PROGRESS, COMPLETED, BUSY, NO_ANSWER,
  FAILED, CANCELED), from, to, `providerCallId` (Twilio CallSid), the published `employeeVersion`
  that took it, `conversationId` (set after the first saved exchange), `customerId`, timestamps,
  `durationSec`, `error`. `CallParticipant`: the customer and the employee. `CallTranscript`: what
  each side said, with `offsetMs` and `interrupted`.
- `CustomerConversation`: links a conversation to its customer (one per conversation) and holds a
  running `summary` of it, which later conversations see as "previous interactions".

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
POST  .../employees/:id/messages                admin; body { conversationId?, message, customer? }; SSE reply
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
GET   /workspaces/:workspaceId/tools            member; the tool catalog
GET   .../employees/:id/tools                   member; tools granted to the employee
PUT   .../employees/:id/tools                   admin; body { tools: [{ name, config }] }; replaces the set
GET   /workspaces/:workspaceId/tool-executions  member; audit log, newest 100; ?employeeId= ?conversationId=
GET   /workspaces/:workspaceId/phone-numbers    member
POST  /workspaces/:workspaceId/phone-numbers    admin; body { number, employeeId, greeting? }; points the Twilio number here
POST  .../phone-numbers/:numberId/reconnect     admin; re-points it (new PUBLIC_URL)
DELETE .../phone-numbers/:numberId              admin
POST  .../employees/:id/calls                   admin; body { to, phoneNumberId?, greeting? }; outbound call
GET   /workspaces/:workspaceId/calls            member; newest 50; ?employeeId=
GET   .../calls/:callId                         member; participants and transcript
POST  /voice/twilio/inbound                     Twilio webhook (signature-checked): answers with <Connect><Stream>
POST  /voice/twilio/status                      Twilio call status callback (signature-checked)
GET   /voice/twilio/stream                      WebSocket: Twilio Media Stream (token-checked on start)
GET   /workspaces/:workspaceId/customers        member; newest 200 by last seen, with profile
GET   .../customers/:customerId                 member; profile, memories, conversations with summaries
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

## Customer memory

```
new conversation with { customer: "rahul@example.com" } -> MemoryService.identify (create if missing)
runTurn: recall (facts, newest 50 + summaries of the last 5 other conversations)
         -> system prompt section "What you remember about this customer"
after the reply is saved, not awaited:
  remember: extraction prompt (known facts + summary so far + the exchange) -> provider
            -> parseExtraction(): drops unknown categories, bad keys, empty or long values,
               secret-looking keys, card numbers; one fact per key, at most 20
            -> one transaction: insert new keys, overwrite learned ones, profile, summary
```

- Only the extractor's validated facts are stored; messages themselves are never memory.
- A failed extraction is logged (`onError`) and loses only that turn's memory; the reply stands.
- Memory is shared by every employee in the workspace. A conversation keeps the customer it
  started with; `customer` in the request is ignored on later turns.
- Every service call takes `{ organizationId, workspaceId }` and finds the customer through them,
  so a customer id from another tenant recalls nothing and cannot be written.

## Tools

```
model asks for a tool (provider-independent ToolCall)
  -> runTurn: only tools offered this turn are run, one at a time, in order
  -> ToolExecutor.execute (packages/tools/src/executor.ts)
       registry lookup        unknown name           -> DENIED
       permission check       no grant in this org/workspace, or the grant lacks a permission
                              the tool now needs     -> DENIED
       grant config check     tool.config schema     -> FAILED
       input validation       tool.input schema      -> INVALID (issues sent to the model)
       execute                timeout per tool; retries only ToolError(retryable), never timeouts
       output validation      tool.output schema
       audit                  one ToolExecution row, whatever happened
  -> result goes back to the model as a tool message; the loop runs up to 6 model calls
```

- A tool is a `ToolDefinition` (`packages/tools/src/types.ts`): name, title, description, Zod `input`,
  `output` and `config` schemas, `permissions`, `timeoutMs`, `retry`, `execute`. The model sees the
  input schema as JSON Schema (`registry.specs`). Add a tool: define it, add it to `toolRegistry` in
  `packages/tools/src/index.ts`, its name to `TOOL_NAMES` and its config schema to
  `toolConfigSchemas` in `packages/shared/src/tool.ts`.
- Tools only get the server-side `ToolContext` (tenant ids, the employee's time zone, admin config,
  a signal, and `safeFetch`). Network access is https to public addresses only, no redirects
  (`net.ts`); `http_request` is further limited to the admin's host list and `send_webhook` to the
  admin's URL.
- Provider-independent tool types live in `packages/ai-provider/src/types.ts`: `ToolSpec`,
  `ToolCall`, assistant messages with `toolCalls` (and `raw`, the provider's own record of the
  turn, replayed unchanged: Anthropic needs its thinking blocks back), and `tool` messages.

## Voice

```
inbound: Twilio -> POST /voice/twilio/inbound -> Call row, caller identified as a customer by number
         -> TwiML <Connect><Stream url=wss://PUBLIC_URL/voice/twilio/stream> with callId + token
outbound: POST .../employees/:id/calls -> Twilio Calls API with the same TwiML inline
stream (apps/api/src/voice/session.ts), one per call:
  start      check token, load the call's published employee version, knowledge, tools, customer
             greeting spoken
  audio  ->  STT (Deepgram, mu-law 8 kHz, no conversion) -> caller turn (endpointing 400 ms)
  turn   ->  runTurn(channel "voice") -> text streamed -> Speaker: sentences -> TTS (ElevenLabs,
             ulaw_8000) in parallel, played in order -> Twilio media + a mark per sentence
  partial with words while the employee talks or thinks -> barge-in: clear, abort the turn
  stop / socket close -> call COMPLETED; Twilio's status callback records the billed duration
```

- Voice has no logic of its own for answers: it calls `runTurn` like test chat, so the employee's
  instructions, goals, knowledge, memory and tools all apply. The only difference is
  `channel: "voice"`, which adds phone-call style rules to the system prompt.
- Calls use the employee's **published** version (test chat uses the latest). Unpublished or
  paused employees do not answer; outbound calls are refused (409).
- A turn cut off by barge-in before it was saved is dropped, and what the caller said is prepended
  to their next turn. If the reply was already saved, it stays, marked interrupted in the transcript.
- Recovery: STT reconnects up to 3 times (buffering ~2 s of audio); a sentence whose TTS fails is
  retried once; a failed reply is apologised for; lost STT ends the call politely; if the stream
  fails, the TwiML after `<Connect>` says sorry and hangs up. Silence: a check-in after 15 s, hang-up
  after 15 s more. Calls end after 30 minutes.
- Config: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_URL`, `DEEPGRAM_API_KEY`,
  `ELEVENLABS_API_KEY` (optional `DEEPGRAM_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`). Without
  them, voice routes answer 503 naming what is missing; the rest of the API works.
- `apps/api/src/try-call.ts` (`pnpm --filter @workforce/api try-call`): a real call without the
  dashboard, in a throwaway organization.

## Agent runtime

```
API route (conversations.ts): authorize, pick the employee version, open the SSE stream
  -> runTurn() in @workforce/agent-runtime
       -> history, customer memory and knowledge, loaded together
       -> buildContext(): system prompt (employee config, memory, knowledge) + last 40 messages + new message
       -> AIProvider.stream(): text chunks, then token usage and any tool calls
       -> tool calls go through ToolExecutor; results go back to the model, repeat (max 6 calls)
       -> saves the user message and the reply together; yields text | done | error events
       -> starts MemoryService.remember in the background when there is a customer
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
`buildApp({ provider, embedder, memory, aiTimeoutMs })`; memory tests wrap the real `MemoryService`
to await its background `remember` calls; knowledge tests upload the sample files in
`apps/api/src/fixtures`. There are no dashboard tests in the repo.
