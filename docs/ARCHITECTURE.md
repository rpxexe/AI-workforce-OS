# Architecture

## Layout

```
apps/api          Fastify 5 + WebSocket, port 4000. Runs TypeScript directly on Node 24.
apps/dashboard    Next.js 16 (App Router), Tailwind 4, shadcn/ui (radix-nova), Clerk. Port 3000.
packages/database Prisma 7 schema, migrations, generated client, exported `prisma`.
packages/shared   Zod schemas and types used by both API and dashboard.
packages/ai-provider   `AIProvider` interface, providers (OpenRouter default, Anthropic, OpenAI, Gemini, any OpenAI-compatible), the model catalog and the model router (`createRouter`).
packages/agent-runtime `runTurn()`: context builder, provider call, timeout, conversation storage.
packages/knowledge     Parsing, chunking, embedding and vector search (`processDocument`, `retrieve`).
packages/memory        Customer memory: `MemoryService` (`identify`, `recall`, `remember`), extraction + validation.
packages/tools         Tool system: registry, executor (permission, validation, timeout, retry, audit), the tools.
packages/telephony     `TelephonyProvider`: Twilio (REST, TwiML, signatures, Media Streams), Telnyx (TeXML), SignalWire (Twilio's code on its LaML API), OmniDimension (delegated: its own agent talks).
packages/stt           `STTProvider`: Deepgram and AssemblyAI (live + files); OpenAI-compatible (Whisper, custom), Google, Azure (files only).
packages/tts           `TTSProvider` (8 kHz mu-law): ElevenLabs, OpenAI-compatible speech (OpenAI, Kokoro, VoiceStudio, custom; WAV converted), Google, Azure, Cartesia, PlayHT.
packages/providers     Phase 14: the provider registry (build + test per catalog entry), sealed credentials, fallback across connections,
                       email senders (SendGrid, SES, SMTP), object storage (S3, R2, GCS, S3-compatible, Azure Blob), AWS SigV4.
packages/workflows     Workflow engine: claims due runs, runs nodes, waits, retries (`createWorkflowEngine`).
packages/channels      Messaging channels: the common message model, `WhatsAppProvider` (Meta, Twilio, Telnyx), `EmailProvider` (Resend; test mode without it), `splitText`.
packages/sdk          Phase 17: the TypeScript SDK for the public API (`createClient`, `paginate`, `streamMessage`, `verifyWebhook`); fetch and Web
                      Crypto only; `generate.ts` writes `src/types.ts` from the contract; `pnpm build` -> `dist/` for npm.
packages/sdk-python   Phase 17: the Python SDK (`workforce_sdk`: `Client`, `paginate`, `stream_message`, `verify_webhook`), standard library only.
workers/evaluation-worker  The evaluation worker: graders, `runEvaluation`, the sweep, regression replays, improvement analysis and `compareKpi` (run as API jobs).
workers/*         agent-worker, call-worker: empty stubs.
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

- `Conversation`: `organizationId`, `workspaceId`, `employeeId`, `channel`, `title`, `status` (AI_ACTIVE,
  WAITING_FOR_HUMAN, HUMAN_ACTIVE, RESOLVED, REOPENED), `assignedTo` (Clerk user id; null = unassigned queue),
  `failedTurns` (consecutive failed turns), `resolvedAt`.
- `ConversationInsight`: the analyzer's output for one conversation (unique per conversation, and per organization + workspace +
  conversation): `primaryLanguage`, `codeSwitchedMessages`, `switches`, `sentiment`, `intent`, `entityTypes` (one per entity),
  `resolution`, `escalated`, `escalationSignals`, and `activityAt` (the conversation's `updatedAt` it was computed from).
  Written by `refreshInsights` (inbox.ts) on insights reads; a row older than the conversation's `updatedAt` is recomputed.
- `ConversationMessage`: `role` (USER, ASSISTANT, AGENT = a human agent, with `authorId`), `content`; assistant rows also carry
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
  follow_up; `value`; `confidence` 0..1 from the extractor, 1 after a person edits, null for old rows; `conversationId` where it
  was last learned). Learning a key again replaces it.
- `CustomerAuditLog`: one row per admin action on a customer's memory (`memory_edit`, `memory_delete`, `memory_clear`,
  `export`), `actorId`, `detail` with keys and counts, never values. `customerId` has no relation, so rows outlive the data.
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
  `durationSec`, `error`. `CallTransfer`: the audit row of each live transfer to a person (`to`, `status` INITIATED,
  COMPLETED, NO_ANSWER, BUSY, CANCELED, FAILED, `error`, `talkSec`, `conversationId`, `handoffId`). `CallParticipant`: the customer and the employee. `CallTranscript`: what
  each side said, with `offsetMs` and `interrupted`.
- `Workflow`: name, description, `status` (DRAFT, ACTIVE, PAUSED), `publishedVersionId`, `hookToken` (secret in
  the webhook trigger URL), `deletedAt` (soft delete; restore clears it).
  `Call.idempotencyKey` (unique) lets a Voice Call step find the call it already placed. `WorkflowVersion`: immutable `definition` JSON, `number` unique per workflow.
- `WorkflowExecution`: one run of a version, and the background job itself: `status` (QUEUED, RUNNING, WAITING,
  COMPLETED, FAILED), `input` (trigger data), `context` (step outputs by node id), `currentNodeId`, `runAt` (when it
  is due; null while waiting for a person), `lockedUntil`, `error`, `startedBy` (user id or "webhook").
- `WorkflowStepExecution`: one attempt at one node: `attempt`, `status` (RUNNING, WAITING, SUCCEEDED, FAILED),
  `input` (settings with templates filled), `output`, `state` (what a waiting step remembers), `error`.
- `EmployeeChannel`: a messaging channel an employee answers on: `kind` (web_chat, whatsapp, email), `address` (widget
  key, the WhatsApp number (Meta: its phone number id), email address; unique per kind, so it routes inbound messages), `enabled`, `config`
  (`channelConfigSchemas[kind]`), `allowedTools` (null = all granted), `secret` (web chat identity and session
  signing; part of the email hook URL). One per kind per employee. Not versioned.
- `ChannelMessage`: the message audit log, one row per message in or out of any channel, voice included: `direction`,
  `status` (inbound RECEIVED, ANSWERED, REJECTED, FAILED; outbound PENDING, SENT, DELIVERED, READ, FAILED), `from`, `to`,
  `text`, `media` (what was sent and what was done with it), `providerMessageId` (unique per channel and direction:
  deduplicates retried webhooks, matches receipts), `customerId`, `conversationId`, `error`, `attempts`, `latencyMs`.
- `Handoff`: one hand-over to people: `trigger` (`HANDOFF_TRIGGERS`), `reason`, `assignedTo`, `requestedAt`,
  `acceptedAt` (a person took over), `firstResponseAt`, `endedAt`, `outcome` (resolved | returned_to_ai). At most one
  open (no `endedAt`) per conversation. Its timestamps are the handoff analytics.
- `CopilotSuggestion`: what the Copilot suggested to an agent (`reply`, `summary`, `nextAction`, `memory`, `citations`,
  usage), apart from the conversation's messages; `usedInMessageId` and `edited` when an agent sent it.
- `Evaluator`: a grader definition per workspace (`key` for the 8 built-in ones), `enabled`, `currentVersionId`.
  `EvaluatorVersion`: immutable `name`, `description`, `dimension` (`EVAL_DIMENSIONS`), `kind` (deterministic, llm, rule),
  `config` (`evaluatorConfigSchemas[kind]`), `passScore`. Saving appends one and makes it current.
- `Evaluation`: one grading of a conversation as it stood at `lastMessageAt`: links to the conversation, the
  `employeeVersionId` and `provider`/`model` of its last reply, and the `workflowVersionId` that started it; `trigger`
  (auto, manual, dataset), `autoKey` (unique: conversation + last message time, so the sweep never queues a state twice),
  `status` (PENDING, RUNNING, COMPLETED, FAILED), `score` (average of the scored results, 0-100), `passed`, `failures`,
  `datasetRunId`/`caseId` for regression runs. `EvaluationResult`: one per evaluator version: `status` (scored, skipped,
  error), `score`, `passed` (score >= passScore), `reason`, `details` ({ findings: [{ message, quote? }], usage? }).
- `EvalDataset` (name unique per workspace), `EvalCase` (`messages` [{ role: customer | employee, content }] copied from a
  conversation or written by hand, `expectations`), `EvalRun` (dataset x employee version: `total`, `passed`, `failed`,
  `score`, `status`).
- `EvalDataset.employeeId` (unique, nullable): marks a dataset as that employee's regression suite.
- `ImprovementSuggestion`: one per failure pattern (`baseVersionId` + `evaluatorId`, unique): `dimension`, `title`, `reason`,
  `evidence` (counts and the newest failing examples with reasons and quotes), `change` ({ summary, fields } with the new
  value of each changed field among systemInstructions, personality, goals), `kpi`, `proposedVersionId` (the version made
  from it, once a person asks), `baselineRunId`/`candidateRunId` (regression runs), `approval` (pending, approved,
  rejected) with `decidedBy`, `decidedAt`, `decisionNote`.
- `EmployeeRollout`: a candidate version served to `percent`% of customers next to the published (control) version;
  `status` active, promoted or rolled_back; `kpi`; `suggestionId`; `activeEmployeeId` (unique, set only while active: one
  active rollout per employee). `EmployeeRelease`: every move of the live pointer (`action` publish, rollback, promote;
  `version`, `previousVersion`, `by`).
- `ProviderConnection` (Phase 14; Phase 13's `AiCredential` rows were copied into it as `llm` connections with the same ids):
  an organization's account with an outside provider. `providerType` (llm, stt, tts, telephony, messaging, email, storage),
  `providerId` (a `PROVIDER_CATALOG` id), `displayName` (unique per organization), `encryptedCredentials` (AES-256-GCM under
  `AI_CREDENTIALS_KEY`: `v2` = JSON of every secret field, `v1` = Phase 13's bare key; never returned), `credentialHints` (last 4 of
  each secret), `configuration` (the catalog's non-secret fields; LLM: `baseUrl`, `models`, `defaultModel`; any: `costPerUnit`),
  `status` (active, disabled), `isDefault` (one per type, kept by the API), `lastTestedAt/Status/Error`, `rotatedAt`.
- `ProviderAuditLog`: create, update, rotate, test, set_default, disable, enable, delete per connection, with the actor. No secrets.
- `AiEmployee.providerOverrides`, `Workflow.providerOverrides` (Phase 14, not versioned): `{ llm?: { connectionId, model }, stt?,
  tts?: { connectionId, voice? }, email? }`; `connectionId` null = the platform's provider explicitly.
- `PhoneNumber.connectionId`, `Call.connectionId`: the telephony connection carrying them (null = the platform's account);
  `Call.workflowId`: the workflow whose Voice Call step placed it. `KnowledgeDocument.storageConnectionId` + `storageKey`: the file
  lives in that object storage (`content` is then null).
- `AiModelPolicy`: per organization and task (`AI_TASKS`; `default` covers tasks without a row): `primary` and `fallbacks`
  ({ credentialId | null = platform, model }), `maxCostUsd`, `timeoutMs`, `allowedProviders`, `strategy` (ordered, fastest, cheapest).
- `AiUsage`: one row per attempt at one provider: `providerType` (Phase 14; llm before), `task`, `operation` (chat,
  live_transcribe, transcribe, synthesize, send, call), `requestId` (shared by a request's attempts; attempt > 1 = fallback),
  `provider`, `model` (model, voice or call direction), `credentialId` (the connection; null = platform), `employeeId`,
  `workflowId`, tokens, `characters` (TTS, transcripts), `seconds` (live audio heard, call length), `costUsd` (provider-reported,
  else estimated from prices / the connection's `costPerUnit`, else null), `latencyMs`, `success`, `errorKind`, `error`.
- `CustomerConversation`: links a conversation to its customer (one per conversation) and holds a
  running `summary` of it, which later conversations see as "previous interactions".

- Phase 16: `BillingAccount` (one per organization: `plan`, Stripe `status`, customer and subscription ids, current period,
  `cancelAtPeriodEnd`), `UsageEvent` (the ledger: `id` = `<sourceType>:<sourceId>`, `kind` (`USAGE_KINDS`), `quantity`, `costUsd`,
  `amountUsd`, `detail`, `occurredAt`; never updated), `UsageCharge` (the usage billed for one period, unique per organization and
  period start, with the Stripe invoice item), `BillingInvoice` (Stripe invoices mirrored by id).

- Phase 17: `ApiKey` (one workspace, `scopes` (`API_SCOPES`), `prefix` (public, unique) + `hash` (SHA-256 of the whole key; the secret
  is never stored), `lastUsedAt/Ip` (written at most once a minute), `expiresAt` (a rotation's grace period), `revokedAt/By`,
  `replacedById`, `rateLimitPerMinute`, `allowedIps` (addresses or CIDR ranges)), `WebhookEndpoint` (workspace, https `url`, `events`
  (`WEBHOOK_EVENTS`), `enabled`, `encryptedSecret` sealed like provider credentials, `previousEncryptedSecret` + `previousSecretExpiresAt`
  (a rotation's grace period), `scannedAt` (the scan cursor)), `DeveloperAuditLog` (who created, changed, rotated, revoked, tested,
  redelivered what; no secrets), `WebhookDelivery` (one event for one endpoint: `eventId` unique per endpoint, `payload` as signed, `status`
  pending/succeeded/failed, `attempts`, `nextAttemptAt`, `lockedUntil`, `log` of every attempt), `ApiIdempotency` (the first answer to
  a request with an `Idempotency-Key`, per workspace, 24 hours).

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
POST  .../employees/:id/publish                 admin; body { version }; first publish activates; 409 while a rollout runs or for an unapproved suggestion's version; logs a release
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
POST  /workspaces/:workspaceId/phone-numbers    admin; body { number, employeeId, greeting? }; the first configured provider owning it takes it and points it here
POST  .../phone-numbers/:numberId/reconnect     admin; re-points it (new PUBLIC_URL)
DELETE .../phone-numbers/:numberId              admin
POST  .../employees/:id/calls                   admin; body { to, phoneNumberId?, greeting? }; outbound call
GET   /workspaces/:workspaceId/calls            member; newest 50; ?employeeId=
GET   .../calls/:callId                         member; participants and transcript
POST  /voice/:provider/inbound                  provider webhook (twilio|telnyx; checked): answers with <Connect><Stream>
POST  /voice/:provider/status                   call status callback (checked); ?callId= on outbound calls
GET   /voice/:provider/stream                   WebSocket: the provider's media stream (token-checked on start)
GET   /workspaces/:workspaceId/workflows        member; ?deleted=true lists deleted ones instead
POST  /workspaces/:workspaceId/workflows        admin; body { name, description?, definition? } (blank: trigger -> end)
POST  .../workflows/validate                    member; body { definition }; returns { issues }
GET   .../workflows/:id                         member; ?version=n; definition, versions, issues, hookUrl (admins only)
PUT   .../workflows/:id                         admin; body { name, description?, definition }; appends a version
POST  .../workflows/:id/publish                 admin; body { version }; 400 with issues if invalid; first publish activates
PATCH .../workflows/:id/status                  admin; ACTIVE | PAUSED
GET   .../workflows/:id/dependencies            admin; { activeRuns, webhookTrigger }: what deleting affects
DELETE .../workflows/:id                        admin; 409 while runs are in progress unless ?stopRuns=true; 204
POST  .../workflows/:id/restore                 admin; undeletes, PAUSED (DRAFT if never published)
POST  .../workflows/:id/duplicate               admin; body { version? }; new DRAFT workflow "Copy of ...", 201
POST  .../workflows/:id/executions              admin; body { input }; 202, runs the published version
GET   .../workflows/:id/executions              member; newest 50
GET   /workspaces/:workspaceId/workflow-executions/:executionId   member; with steps and definition
POST  .../workflow-executions/:executionId/retry                admin; FAILED only, from the failed step
POST  .../workflow-executions/:executionId/resume               admin; continues a Human Handoff
POST  /hooks/workflows/:id/:token               public; JSON body becomes the trigger data; 202 { executionId }
GET   .../employees/:id/channels                member; { channels, whatsappProviders }; secrets and the email hook URL for admins only
PUT   .../employees/:id/channels/:kind          admin; web_chat | whatsapp | email; body { enabled, allowedTools, config }; 409 if another employee has the address
DELETE .../employees/:id/channels/:kind         admin; the log stays
GET   /workspaces/:workspaceId/channel-messages member; newest 100; ?employeeId= ?customerId= ?conversationId= ?channel=
GET   /channels/whatsapp/meta/webhook           public; Meta's subscription handshake (hub.verify_token)
POST  /channels/whatsapp/:provider/webhook      public; meta | twilio | telnyx; signature checked (X-Hub-Signature-256, X-Twilio-Signature,
                                                Ed25519); 200 at once (Twilio: empty TwiML), answered in the background
POST  /hooks/email/:channelId/:token            public; { from, subject, text, messageId, inReplyTo? }; 202
GET   /widget.js                                public; the web chat widget
GET   /chat/:key/demo                           public; a page showing the widget
POST  /chat/:key/session                        public, origin-checked; { visitorId? } or { customer, customerHash }; token, greeting, history
POST  /chat/:key/messages                       public, origin-checked, Bearer session token; { message }; SSE reply (ChatStreamEvent)
GET   /chat/:key/messages?after=                public, Bearer session token; { status, messages }: agents' messages since `after`
GET   /workspaces/:workspaceId/inbox            member; ?view=queue|mine|waiting|human_active|ai_active|reopened|resolved|all ?employeeId=; { items, counts }
GET   /workspaces/:workspaceId/conversations/:conversationId            member; messages, handoffs, Copilot suggestions, canReply
PATCH .../conversations/:conversationId         member; { action: take_over | assign (userId|null) | return_to_ai | resolve | reopen }; 409 if it moved
POST  .../conversations/:conversationId/messages  member; { text, suggestionId? }; takes over, sends on the channel (502 if that fails), then stores
POST  .../conversations/:conversationId/copilot   member; a CopilotSuggestion
GET   /workspaces/:workspaceId/handoffs/analytics member; ?days= (default 30); aggregated in SQL (percentile_disc = stats()' nearest rank)
GET   /workspaces/:workspaceId/insights        member; ?days= (default 30); InsightsOverview (Phase 15; the conversation detail carries `insight`);
                                                first (re)analyzes up to 500 missing/stale conversations, then counts stored ConversationInsight rows in SQL
GET   /analytics/report                         member; ?from&to (to exclusive, <= 366 days)&workspaceId?; AnalyticsReport (Phase 16)
GET   /workspaces/:workspaceId/dashboard        member; ?days=7|30|90; DashboardSummary: counts in SQL, open queue, quality, employees, this workspace's and the organization's billed usage, plan limits, attention thresholds
PUT   /workspaces/:workspaceId/attention        admin; { handoffRateRise, qualityScoreBelow, limitUsedPercent }; stored on Workspace.attention (JSON), defaults when unset
GET   /billing                                  member; BillingOverview: plan, status, period, limits with use, usage, invoices, plans
GET   /billing/usage                            member; ?from&to; UsageSummary (ledger totals, cost, billed, newest 100 entries with sources)
POST  /billing/checkout                         admin; { plan }; no subscription: { url } (Stripe Checkout); else changes the price ({ url: null }); free = cancel at period end
POST  /billing/portal                           admin; { url } of Stripe's customer portal; 409 without a customer
POST  /billing/stripe/webhook                   public; Stripe-Signature checked (5 minutes); idempotent handlers
GET   /workspaces/:workspaceId/evaluators       member; creates the 8 built-in ones on first call; with 30-day pass counts
POST  /workspaces/:workspaceId/evaluators       admin; body evaluatorSchema (name, description, dimension, kind, config, passScore); 201
GET   .../evaluators/:id                        member; current version, all versions, its newest 50 results
PUT   .../evaluators/:id                        admin; body evaluatorSchema; appends a version and makes it current
PATCH .../evaluators/:id                        admin; { enabled }
GET   /workspaces/:workspaceId/evaluations      member; production evaluations, newest 100; ?failed=true ?dimension= ?evaluatorId= ?employeeId= ?days=
GET   .../conversations/:conversationId/evaluations   member; newest 20 with results (drill-down)
POST  .../conversations/:conversationId/evaluations   admin; queues a manual evaluation; 202 (PENDING)
GET   /workspaces/:workspaceId/quality          member; ?days= ?employeeId=; QualityOverview, aggregated in SQL (GROUPING SETS), no cap
GET   /workspaces/:workspaceId/datasets         member; with case counts and the last run
POST  /workspaces/:workspaceId/datasets         admin; { name, description? }; 409 if the name is taken
GET   .../datasets/:id                          member; cases and newest 50 runs
DELETE .../datasets/:id                         admin; 409 while a run is in progress; 204
POST  .../datasets/:id/cases                    admin; { name, expectations?, conversationId | messages }; 201
DELETE .../datasets/:id/cases/:caseId           admin; 204
POST  .../datasets/:id/runs                     admin; { employeeId, version? } (default: published, else latest); 202
GET   /workspaces/:workspaceId/eval-runs/:id    member; the run with each case's evaluation and results
GET   /workspaces/:workspaceId/improvements     member; newest 100 suggestions; ?employeeId=
POST  .../improvements/analyze                  admin; queues improvement/analyze; 202
GET   .../improvements/:id                      member; ImprovementDetail (evidence, base and proposed config, tests, rollout)
POST  .../improvements/:id/test                 admin; creates the proposed version once, fills the regression suite, runs it on base and proposed; 202
POST  .../improvements/:id/decision             admin; { decision: approve | reject, note }; approve needs both runs COMPLETED
GET   .../employees/:id/releases                member; active rollout and history with KPI results, release log, suite, rollbackTo
POST  .../employees/:id/regression-suite        admin; creates the suite if missing; { id }
POST  .../employees/:id/rollouts                admin; { version, percent, kpi }; 201; 409 if one runs or the suggestion is unapproved
PATCH .../employees/:id/rollouts/:rolloutId     admin; { action: set_percent (percent) | promote | rollback }
POST  .../employees/:id/rollback                admin; publishes the version live before the current one; 409 during a rollout
GET   /ai/settings                              member; platform provider and model, credentials (no keys), policies, canStoreKeys
POST  /ai/credentials                           admin; credentialSchema; 201; 503 without AI_CREDENTIALS_KEY; custom base URLs must be public https
PUT   /ai/credentials/:id                       admin; blank apiKey keeps the stored key; the provider cannot change
DELETE /ai/credentials/:id                      admin; 409 while a policy uses it; 204
PUT   /ai/policies/:task                        admin; modelPolicySchema; credentials must be the organization's (400)
DELETE /ai/policies/:task                       admin; back to the default policy / the platform; 204
GET   /ai/usage                                 member; ?days= (default 30); totals, by model, by task, newest 100 calls
GET   /providers/registry                        member; PROVIDER_CATALOG (metadata, fields, capabilities, status)
GET   /providers/settings                        member; connections (hints only; webhookUrls for admins), what .env provides per type, canStoreKeys
POST  /providers/connections                     admin; { providerType, providerId, displayName, credentials, configuration }; 201; checked against the catalog; typed addresses public https
PATCH /providers/connections/:id                 admin; { displayName?, configuration? } (secrets only by rotation)
POST  .../connections/:id/rotate                 admin; { credentials }: every secret again; resets the last test
POST  .../connections/:id/test                   admin; TestConnectionResult; 10 per organization per minute (429); a press while one runs shares it
POST  .../connections/:id/default                admin; the organization's default for the type
POST  .../connections/:id/status                 admin; { status: active | disabled } (disabling clears default)
DELETE /providers/connections/:id                admin; 409 naming what uses it (policies, overrides, numbers, WhatsApp channels, stored files); 204
GET   /providers/audit                           admin; newest 100
GET   /providers/metrics                         member; ?days=; per provider and type: requests, failures, timeouts, fallbacks, latency, cost, characters, seconds
GET|PUT /workspaces/:workspaceId/employees/:id/providers   member | admin; ProviderOverrides (connections must be the organization's, active, of the type)
GET|PUT /workspaces/:workspaceId/workflows/:id/providers   member | admin; ProviderOverrides
POST  /voice/:provider/c/:connection/inbound|status|transfer   as the platform's routes, for an organization's phone connection (its token)
GET   /voice/:provider/c/:connection/stream     the media stream of a call on that connection
GET|POST /channels/whatsapp/:provider/c/:connection/webhook   as the platform's, for an organization's WhatsApp connection
POST  /channels/email/resend/c/:connection/webhook             received mail through an organization's Resend connection
GET   /developer/api-keys                       member; ApiKeyInfo[] (never the secret)
POST  /developer/api-keys                       admin; { name, workspaceId, scopes, expiresInDays?, rateLimitPerMinute?, allowedIps? }; 201 CreatedApiKey: the only response with the secret
PATCH /developer/api-keys/:id                   admin; { name?, rateLimitPerMinute?, allowedIps? }; 409 when revoked
POST  /developer/api-keys/:id/rotate            admin; { expireOldInHours: 0..168 }; a new key, the old one expires then (0: revoked); 409 unless active
DELETE /developer/api-keys/:id                  admin; revokes (kept for the record); idempotent
GET   /developer/webhooks                       member; endpoints with pending/failed counts (7 days)
POST  /developer/webhooks                       admin; { url (public https), description, workspaceId, events }; 201 with the signing secret once; 503 without AI_CREDENTIALS_KEY
PATCH /developer/webhooks/:id                   admin; { url?, description?, events?, enabled? }
POST  /developer/webhooks/:id/rotate-secret     admin; { keepOldForHours: 0..168 }; the new secret once; both sign during the grace period
POST  /developer/webhooks/:id/test              admin; sends webhook.test now (any subscription, even turned off); the delivery with its attempt
DELETE /developer/webhooks/:id                  admin; deliveries go with it; 204
GET   /developer/webhooks/:id/deliveries        member; { data, nextCursor }, newest first, with payload and attempts; ?status= ?event= ?limit= ?cursor=
POST  /developer/webhook-deliveries/:id/redeliver   admin; pending again with fresh attempts (same event id); 409 if pending
GET   /developer/audit                          admin; newest 100 developer audit entries
GET   /v1/openapi.json                          public; the OpenAPI 3.1 document (routes, scopes, shapes, webhooks)
*     /v1/...                                   API key (Bearer wfk_...); the routes of PUBLIC_ROUTES (packages/shared/src/public-api.ts), see below
GET   /workspaces/:workspaceId/customers        member; newest 200 by last seen, with profile; ?q= searches name/email/phone/company/externalId
GET   .../customers/:customerId                 member; profile, memories, conversations (channel, status) with summaries
PATCH .../customers/:customerId/memories/:id    admin; { value }; extraction's validation, profile follows, confidence 1; audited
DELETE .../customers/:customerId/memories/:id   admin; profile field cleared for identity keys; audited
DELETE .../customers/:customerId/memories       admin; clears facts, profile and summaries (conversations stay); audited
GET   .../customers/:customerId/export          admin; JSON attachment: profile, memories, conversation summaries; audited
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
inbound: provider -> POST /voice/<provider>/inbound -> Call row, caller identified as a customer by number
         -> TwiML/TeXML <Connect><Stream url=wss://PUBLIC_URL/voice/<provider>/stream> with callId + token
outbound: POST .../employees/:id/calls -> the calling number's provider, the same markup inline
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
- Providers (`packages/telephony`): Twilio and Telnyx (TeXML, Twilio-compatible markup) behind
  `TelephonyProvider`. Both can be configured at once; `PhoneNumber.provider` and `Call.provider`
  say which one a number and a call use. A number is matched to a provider when it is assigned.
- **OmniDimension** (Settings connection only: API key + agent id) is a *delegated* provider (`TelephonyProvider.delegated`):
  its own agent (speech, model, voice) runs the call, so there is no media stream and no speech providers are needed. Outbound
  only: `placeCall` dispatches to the agent with the number's OmniDimension id, `call_context` (employee name, greeting),
  `metadata.callId` and a per-call post-call webhook to `/voice/omnidimension/c/<connection>/status?callId=&sig=` (HMAC of the
  call id with the API key; OmniDimension documents no signature). The JSON webhook sets the status and duration and, once
  (claimed on `Call.conversationId`), saves the interactions as the call's conversation, transcript and message log, the summary
  on `CustomerConversation`, and runs memory extraction over the whole call. No transfer, no hang-up, no inbound.
- Config: `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` and/or `TELNYX_API_KEY` + `TELNYX_APP_ID`
  (optional `TELNYX_ACCOUNT_SID`), `PUBLIC_URL`, `DEEPGRAM_API_KEY`,
  `ELEVENLABS_API_KEY` (optional `DEEPGRAM_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`). Without
  them, voice routes answer 503 naming what is missing; the rest of the API works.
- `apps/api/src/try-call.ts` (`pnpm --filter @workforce/api try-call`): a real call without the
  dashboard, in a throwaway organization.

## Channels

```
WhatsApp webhook / inbound email -> InboundMessage (packages/channels: normalized, from = +digits or email)
  -> channelService.receive (apps/api/src/channels/service.ts)
       audit row INBOUND RECEIVED (createMany skipDuplicates on providerMessageId: retried webhooks stop here)
       one at a time per channel + customer (in-process queue), then:
       channel off / over 20 a minute / employee not live -> REJECTED, no reply
       customer = identify(from)      the same id voice uses (caller number) -> one memory for all channels
       WhatsApp: mark read + typing (Meta); files: voice notes -> STT.transcribe, documents -> parseDocument, rest described
       conversation: the customer's one on this channel updated in the last 24 h (email: the one our replied-to email is in)
       runTurn(channel kind, published version, tools limited by the channel) -> reply
       splitText(reply, channel limit) -> ChannelSender.send -> OUTBOUND rows PENDING -> SENT/FAILED (+attempts, latency)
       inbound row -> ANSWERED | FAILED (an apology is sent) | REJECTED, after the reply has left
WhatsApp status webhook -> DeliveryUpdate -> outbound row SENT < DELIVERED < READ (never backwards), FAILED + reason
web chat: session (origin, identity) -> signed token -> each message: runTurn streamed as SSE, logged like the rest
voice: each caller turn and reply is logged to ChannelMessage too (channel "voice")
```

- Every channel answers with the employee's **published** version through `runTurn`; the channel decides only who
  the customer is, which conversation continues, and how the reply is delivered. `channel` reaches the system prompt
  as style rules (`CHANNEL_STYLE` in `context.ts`), and recalled summaries say which channel they came from.
- Cross-channel continuity: customers are keyed by `normalizeCustomerId` (phone `+digits`, lower-case email), so a
  caller writing on WhatsApp, or a website visitor the site vouches for with the same number, is the same customer:
  facts plus the summaries of their last 5 conversations on any channel reach the prompt.
- Web chat identity: anonymous visitors are `visitor:<uuid>` (kept in localStorage). A website that knows the visitor
  sends `customer` and `customerHash` = HMAC-SHA256(channel secret, customer), computed on its server; only then is the
  visitor matched to an existing customer. Session tokens are HMAC-signed `{ channel, customer, expiry }` (12 h).
- Capability limits: per-channel tool list (the runtime offers only those, and passes them to the executor as
  `allowedTools`, which denies any other call); web chat can require a verified identity and limits the websites
  that may show it (the API's own preview page is always allowed); WhatsApp replies are split at 4096 characters;
  files are read only on WhatsApp, up to 10 MB.
- WhatsApp providers (`WhatsAppProvider` in `packages/channels/src/types.ts`): `parseWebhook` (verifies and returns
  messages and receipts, or null), `send`, `downloadMedia`, optional `markRead` and `verifySubscription`, and the
  webhook `ack`. Implementations: `whatsapp-meta.ts` (Graph API v26.0), `whatsapp-twilio.ts` (Messages API, form
  webhooks, `StatusCallback` = webhook URL + `?event=status`, media with Basic auth), `whatsapp-telnyx.ts`
  (`/v2/messages/whatsapp`, Ed25519 webhooks within 5 minutes, `payload.body` read as Meta's message object). All can be
  configured at once; a WhatsApp channel's `config.provider` (default meta) says which one carries its number, and a
  webhook from another provider for that number is ignored. Adding a provider: implement the interface, add it to
  `whatsappProvidersFromEnv` and `WHATSAPP_PROVIDERS`.
- Send errors: only answers that mean "not sent, try later" are retried twice (1 s, 4 s): HTTP 429, Meta 4, 80007,
  130429, 131016, 131056, Twilio 20429 and 63018. Network errors and 5xx are not, since a retry could send twice,
  except on Telnyx, whose sends carry an `Idempotency-Key` (the outbound log row id). Codes an admin will meet (Meta
  131047 and Twilio 63016, the 24-hour window; 131026; 190; 20003) are logged in plain words.
- Config: Meta `META_WHATSAPP_ACCESS_TOKEN`, `META_APP_SECRET`, `META_WHATSAPP_VERIFY_TOKEN` (optional
  `META_GRAPH_VERSION`); Twilio the voice keys `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`; Telnyx `TELNYX_API_KEY` and
  `TELNYX_PUBLIC_KEY`. Receipt URLs are built from `PUBLIC_URL`. An unconfigured provider's webhook answers 503 naming
  what is missing; numbers can be saved either way. `buildApp({ whatsapp, publicUrl })` lets tests pass providers
  with a fake `fetch`.
- Dashboard: the employee page's Channels card (`components/employees/employee-channels.tsx`: a tab per channel,
  settings, tool limits, embed code and identity secret, Meta callback URL, email hook) and Message log
  (`channel-log.tsx`, filter by channel). The widget is `apps/api/src/channels/widget.js`, plain JS in a shadow root.

## Workflows

```
editor (React Flow, dashboard)  draws and edits a WorkflowDefinition: { nodes: [{ id, type, name, position,
                                config }], edges: [{ source, target, branch? }] }. Nothing in React runs a step.
PUT -> WorkflowVersion (append-only)    publish -> validateWorkflow + employee/tool checks -> live pointer
start (dashboard, API, webhook) -> WorkflowExecution QUEUED at the trigger node
Inngest: workflow/run.due per due run -> engine.runOne (claim this run, advance) -> step.sleepUntil; sweep every minute
without Inngest: runner (engine.startRunner, every 1 s, in the API process)
  claim:   UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED): active workflows, due runAt,
           or RUNNING with an expired lock (its runner died)
  advance: per node: step row -> settings (defaults + {{templates}}) -> handlers[type]
           -> SUCCEEDED (output into context, follow the edge / yes|no branch) | WAITING (runAt) | FAILED
```

- Definition schema, per-node settings (`nodeConfigSchemas`), `validateWorkflow`, `blankWorkflow` and the example
  `leadFollowUpWorkflow` live in `packages/shared/src/workflow.ts`, so the editor shows the issues publishing
  enforces. Saving accepts incomplete settings; publishing does not.
- Templates: `{{trigger.field}}`, `{{steps.<node id>.field}}` (`packages/workflows/src/template.ts`). In tool
  arguments a value that is exactly one template keeps its type.
- Nodes (`packages/workflows/src/nodes.ts`): Trigger (manual | webhook); AI Employee (`runTurn`, channel
  "workflow", published version); Condition (compare, or the model answers yes/no about the run's data); Tool
  (through `ToolExecutor` with the chosen employee's grant; the run id is the audit row's conversation id; a
  calendar conflict fails the step); HTTP Request and Webhook (`safeFetch`; Webhook POSTs the run data with an
  idempotency key); Wait; Voice Call (places the call through the voice routes' `placeCall`, then checks the Call
  row every `callPollMs` until it ends; output includes the transcript); Message (email through the server's mailer, Resend; test mode without it); CRM Update
  (customer memory via `identifyCustomer` + `factWrites`); Human Handoff (waits until Continue); End.
- Validation also checks references: `{{steps.<id>}}` must name a step that runs before this one on every path
  (a dominator), not the step itself; other roots than `trigger`/`steps` are refused. Only conditions may have
  yes/no edges.
- Pause holds runs between steps and keeps them from being claimed; resume releases them. Retry re-queues a FAILED
  run at its failed node, which gets a new attempt row. A step that was RUNNING when its runner died runs again,
  as the same attempt (`interrupted`).
- Idempotency key per step attempt: `executionId:nodeId:attempt`. Tool: the audit row id is `wf:<key>`; a re-run
  reuses its recorded outcome, and the webhook tool sends it as its key. HTTP Request and Webhook send it as the
  `Idempotency-Key` header. Voice Call: `placeCall` with the same key returns the earlier call, or fails if that
  try stopped mid-dial. AI Employee: an interrupted turn fails (it may have used tools). Message sends
  it to Resend as the `Idempotency-Key`. CRM Update writes are upserts. A manual retry is a new attempt and acts again.
- Engine transitions only apply while the run is still RUNNING (`settle`), so a run stopped mid-step stays stopped.
- Delete: hides the workflow, 404s its hook URL, fails runs in progress ("Stopped: the workflow was deleted"; they can
  be retried after a restore). Duplicate copies one version into a new draft with its own hook token.
- Dashboard: `/workflows` (list; new from blank or the example; deleted workflows with Restore) and
  `/workflows/[id]` (Save draft, Restore as vN for an old version, Publish, Pause/Resume, Duplicate, Delete with
  a confirmation listing what it affects; editor tab: canvas, step palette, settings panel, checks; runs tab: start with JSON input, history, per-run canvas coloured by step status,
  steps with input and output, Retry, Continue). Components in `src/components/workflows/`.

## Human handoff (Phase 10)

```
runTurn, conversation WAITING_FOR_HUMAN or HUMAN_ACTIVE -> save the customer's message only -> `held` (no reply;
        channels mark the inbound row HELD, web chat polls, voice says a colleague will follow up and hangs up)
runTurn, AI_ACTIVE / REOPENED / RESOLVED (-> REOPENED):
  before the model (handoff.ts handoffBeforeReply, needs escalation.enabled):
     explicit request (English phrases), high-value customer (a memory number >= minimum, once per conversation),
     configured conditions (message / memory: contains, equals, at least, at most; each once per conversation)
  during: transfer_to_human tool offered with the employee's tools (reasons customer_request, low_confidence,
     policy_risk, as enabled); a call ends the turn. A FAILED tool execution (onToolFailure) hands off after the reply.
  after an error: failedTurns + 1; at afterFailedAttempts -> repeated_failure
  handoff: the reply ends with escalation.handoffMessage (default line); saved with a Handoff row, status
     WAITING_FOR_HUMAN, assignedTo null; `done.handoff`; onHandoff -> email to escalation.contactEmail (Resend, or
     logged in test mode)
inbox (apps/api/src/inbox.ts): take_over/assign/return_to_ai/resolve/reopen move only from the states they name
  (updateMany on status) and stamp the open Handoff; an agent message takes over, is delivered by
  channelService.deliverAgentMessage (WhatsApp/email sent; web chat and test chat read it), then stored as AGENT
voice: after a handoff (or a turn held because people took over), with escalation.transferNumber:
  "connecting you" line -> CallTransfer INITIATED -> TelephonyProvider.transferCall (live-call update with
  <Dial action=/voice/<provider>/transfer?transferId=>number</Dial>; Twilio Twiml, Telnyx Texml) -> our stream ends,
  the call is not marked ended (the status callback ends it)
  POST /voice/<provider>/transfer (signed): dialResultOf -> COMPLETED (talkSec; conversation HUMAN_ACTIVE, handoff
  accepted and answered) -> <Hangup/>; NO_ANSWER / BUSY / CANCELED / FAILED -> "someone will call you back", hang up,
  conversation stays WAITING_FOR_HUMAN. Provider refuses to dial: FAILED + error, callback line, hang up.
  No transfer number: callback line, hang up. Transfers show in the call detail and the inbox timeline.
workflow Human Handoff step: optional conversationId -> startHandoff(trigger workflow_condition), then waits as before
```

- Only `runTurn` decides whether the AI answers, so every channel respects the state. The final save is conditional on
  the status (`where status in AI_ACTIVE, REOPENED, RESOLVED`): if an agent took over mid-turn, only the customer's
  message is kept and the turn ends `held`.
- Context: AGENT messages reach the model as the employee's own, with a system note that a human colleague handled part
  of the conversation; consecutive same-role messages are joined (`buildContext`).
- Copilot (`packages/agent-runtime/src/copilot.ts`, `suggest`): the last 40 messages as a labelled transcript, the
  customer's recalled memory and the knowledge retrieved for their last message, under the employee's own system
  prompt; the model answers JSON (summary, reply, nextAction, citation numbers). Memory and citations come from the
  data, not from the model; citations fall back to everything retrieved when the model names none.
- Analytics: Handoff timestamps (accept, first reply, resolve: median, average, p90), outcomes, triggers, per agent;
  reply time from SQL (`LAG` over messages: a customer message to the next ASSISTANT or AGENT message).
- Dashboard: `/conversations` (inbox views with counts, refreshed every 5 s), `/conversations/[id]` (timeline with
  handoff events, take over / assign / return to AI / resolve / reopen, reply box, Copilot card), `/analytics`; agent
  names from Clerk members (`lib/members.ts`). Test chat shows agent messages and the handoff state; the employee form
  has the new escalation settings.

## Quality control (Phase 11)

```
conversation quiet 10 min (sweep: Inngest cron every 5 min, or a timer in process; never in test apps)
  or "Evaluate now" (admin)  -> createEvaluation: PENDING row with the employee version + model of the last reply and
                                the workflow version (AI Employee step output, or a Voice Call step's call idempotency key)
  -> job evaluation/requested -> runEvaluation (workers/evaluation-worker): claim PENDING -> RUNNING
       load messages (<= lastMessageAt, newest 200), handoffs, tool executions, the employee version's config,
       the cited pages' text, the case's expectations
       every enabled evaluator's current version, in parallel:
         deterministic  tool_success | escalation_handling | reply_latency   (graders.ts, no model)
         rule           phrase lists, forbid/require, on the employee's or the customer's messages (escaped, whole words)
         llm            GRADER_PROMPT + rubric + employee config + knowledge + numbered transcript -> JSON score/reason/findings
       -> EvaluationResult rows + score / passed / failures, COMPLETED (one grader's error does not lose the rest)
dataset run (admin) -> job evaluation/dataset.run -> per case (step.run): new conversation on channel "evaluation",
       customer messages through runTurn with the chosen version (no tools, no customer, no handoff notices)
       -> createEvaluation(dataset) + runEvaluation; a failed replay is a FAILED evaluation with the reason -> finishRun
```

- Evaluation never runs inside a customer's turn and never writes anything the runtime reads: grades are for people.
- Scores are 0-100. A result passes at its version's `passScore`; skipped (nothing to judge) and error results do not
  count. A conversation passes when no result failed; its score is the average of the scored results.
- The 8 built-in evaluators (`DEFAULT_EVALUATORS` in `workers/evaluation-worker/src/defaults.ts`): correctness,
  grounding, tone, resolution (LLM); policy rules and satisfaction signals (phrase rules); tool success and escalation
  handling (deterministic). Created per workspace on the first evaluator list, manual evaluation or dataset run; the
  sweep also covers workspaces that have none yet.
- The `evaluation` channel (`EVALUATION_CHANNEL`) keeps replays out of the inbox, handoff analytics, the employee's
  test-chat list and the sweep. The overview and failures list count only auto and manual evaluations.
- Dashboard: `/quality` (tabs: Overview, Failures, Evaluators, Datasets), `/quality/evaluators/new` and `[id]` (form:
  saving adds a version; versions; recent results), `/quality/datasets/[id]` (cases, write a case, run against a version,
  run results per case). The conversation page has a Quality card (`components/quality/conversation-quality.tsx`): the
  results with findings, Evaluate now, Add to dataset.

## Continuous improvement (Phase 12)

```
improvement/analyze (button, or the daily improvement-analysis schedule on Inngest for workspaces with recent failures)
  -> findFailurePatterns: production results failing >= 3 times and >= 20% on an ACTIVE employee's live version, last 14 days,
     with no suggestion for that version + evaluator yet (workers/evaluation-worker/src/improve.ts)
  -> per pattern (5 per run): IMPROVE_PROMPT + configuration + check (rubric or rules) + 8 failing examples -> JSON
  -> parseProposal: only systemInstructions, personality, goals; valid config; must differ -> ImprovementSuggestion
     (no version is created: nothing about the employee changes)
admin "test" -> version N+1 = base + change (createdBy the admin, unpublished)
             -> regression suite (EvalDataset.employeeId; created on first use) + the evidence conversations ("do not repeat")
                + up to 5 recent passing conversations (guards) as cases
             -> two EvalRuns (base, proposed) -> evaluation/dataset.run each (Phase 11 replay + grading)
             -> TestComparison per case: fixed / broken / same
admin decision (approve needs both runs COMPLETED) -> rollout (admin): EmployeeRollout active, percent, kpi
serving: liveEmployee (channels, web chat), liveVersion (voice), the workflow AI Employee step
  -> servedVersion(published, activeRollout, customer key): sha256(rollout id + key) % 100 < percent -> candidate
KPI: production evaluations (auto, manual) per version; candidate since the start, control from 14 days before the start;
     compareKpi: means (score, or 0/100 per pass) and a two-sided 95% Welch test, verdict only with >= 10 per side
promote -> rollout promoted + publish (release "promote")   rollback -> rollout rolled_back (nothing published)
employee rollback -> publishes rollbackTarget: the previousVersion of the newest non-rollback release of the live version
```

- The customer key is the channel's normalized customer id (`+digits` phone, lower-case email, `visitor:<id>`), so a
  customer gets the same version on calls, WhatsApp, email and web chat. Workflows use the step's customer, else the run id.
  Test chat keeps using the latest version; Copilot keeps the published one.
- Raising the share keeps everyone already on the candidate; lowering it moves some back.
- Publishing is refused while a rollout runs and for a suggestion's version until it is approved (`assertPublishable` in
  `apps/api/src/releases.ts`). Every pointer move goes through `release()`, which writes `EmployeeRelease`.
- Dashboard: `/improvements` (list, Find improvements), `/improvements/[id]` (pipeline, evidence, proposed change as a diff,
  regression tests per case, approval with a note, rollout), the employee page's Releases card
  (`components/employees/employee-releases.tsx`: rollout panel or start, roll back to the previous version, regression suite,
  history) and `/employees/[id]/compare` (two versions, field-by-field line diff, `components/improvements/config-diff.tsx`).

## Model routing and BYOAI (Phase 13)

```
caller (runTurn's caller, memory, Copilot, graders, improvement, workflow condition)
  -> ai.provider({ organizationId, workspaceId, task })        a provider bound to a route (apps/api/src/ai.ts)
  -> router.stream(request)                                     packages/ai-provider/src/router.ts
       plan: the task's policy, else the "default" policy, else the platform provider alone (planFor)
             targets = primary + fallbacks, each a concrete provider (the platform's, or one built from a sealed key)
       filter: allowed providers, tools needed -> model can call tools, estimated tokens (chars / 4) + 1024 <= context,
               estimated cost <= maxCostUsd (unknown price = skipped when a limit is set); duplicates dropped
       order:  ordered | fastest (measured average latency; unmeasured first once) | cheapest; models that failed for
               rate_limit / unavailable / timeout in the last 30 s go last; at most 3 attempts
       try:    each target once, with the policy timeout per attempt; fall back only before any text reached the caller,
               and not on a refusal or when the caller cancelled
       record: one AiUsage row per attempt (not awaited); `done` carries provider, model and costUsd of who answered
  -> runTurn / Copilot / graders store the `done` event's provider and model, so replies name the model that wrote them
```

- Tasks: chat (test chat, channels, workflow AI Employee steps, regression replays), voice, memory, copilot, evaluation,
  improvement, workflow (condition steps). Embeddings are not routed (the vector column fixes the model).
- No policy behaves exactly as before Phase 13: the platform provider from `.env` (`AI_PROVIDER`, `AI_MODEL`).
- Keys: write-only. Sealed with AES-256-GCM (key = sha256 of `AI_CREDENTIALS_KEY`), opened per call in the planner, passed to
  the provider; responses carry `keyHint` only. Custom (OpenAI-compatible) base URLs must be public https at save time, and
  are called through `safeFetch` (public addresses only, no redirects).
- Providers: OpenAI (`max_completion_tokens`), Gemini (its OpenAI-compatible endpoint), OpenRouter, Groq, Mistral, DeepSeek, xAI,
  Together, Fireworks, Hugging Face (router.huggingface.co) and custom endpoints share `openai-compatible.ts`; Anthropic uses its
  SDK with the organization's key. Since Phase 14 the keys are `llm` provider connections (`/ai/credentials` reads and writes
  them), and the router no longer falls back on `auth` or `config` errors. OpenRouter's `usage.cost` is used as the real cost.
- Prices: Anthropic's current models are built in (`catalog.ts`); other models' prices and context come from the credential's
  `models` list. `buildApp({ credentialsKey, byoProvider })` lets tests set the secret and fake the providers built from keys.
- Dashboard: `/model-routing` ("Model routing": tabs Policies, Usage; `components/ai/`). Keys are language-model connections in
  Settings > AI Providers since Phase 14; `/ai-models` redirects to `/model-routing`.

## Provider settings (Phase 14)

```
PROVIDER_CATALOG (packages/shared/src/providers.ts)   metadata: id, type, name, status, capabilities, credential and config fields,
                                                       models, docs URL, notes. The dashboard renders forms from it.
REGISTRY (packages/providers/src/registry.ts)          per supported entry: build(conn) -> the adapter, test(conn) -> a cheap call
ProviderConnection (sealed secrets + settings)         per organization; opened only on the server (providers/service.ts `conn`)

request -> resolution, per type (apps/api/src/providers/service.ts; LLM in ai.ts planFor):
             workflow override -> employee override -> organization default -> platform (.env)
           the first level that exists serves; the levels after it that the organization set up are its fallbacks
           (LLM: overrides, then the task policy / default policy, else the default connection's defaultModel, else platform)
        -> fallback (packages/providers/src/fallback.ts; router.ts for LLM): each target once (deduplicated), at most 3,
           never after output reached the caller (text streamed, audio played), never on auth/config/refusal or a cancel;
           email only after a "try later" refusal; storage, telephony and messaging never (a file or number lives in one place)
        -> one AiUsage row per attempt (providerType, operation, employee, workflow, characters/seconds, cost)
```

- Where each type is resolved: LLM in every `ai.provider(route)` (routes now carry `employeeId`/`workflowId`); STT and TTS per
  call (`speechFor` in voice/routes.ts: checked before a number answers or an outbound call dials; a call needs a provider with
  the `live` capability) and per WhatsApp voice note; email per send (`Mailer.send(email, scope)`: tool, workflow step, handoff
  email, email channel replies); storage = the organization's default (no overrides) for new knowledge uploads; telephony = the
  number's connection (assigned at "add number": the one named, else the default, else the platform's accounts); WhatsApp = the
  channel's `config.connectionId`.
- Webhooks: an organization's phone and WhatsApp accounts post to `/voice/<provider>/c/<connection>/...` and
  `/channels/whatsapp/<provider>/c/<connection>/webhook` (shown on the connection to admins), verified with that connection's
  token (Twilio/SignalWire HMAC, Meta app secret, Telnyx Ed25519 on WhatsApp and the URL token on calls). A number or channel answers only on the connection it belongs
  to, so another organization's validly signed webhook cannot reach it. The platform's `.env` paths are unchanged.
- Test Connection: auth status (ok / failed / unknown), config status (ok / invalid), capabilities, latency, the provider's error
  with every secret removed, models or voices when listed. Calls that cost nothing where the provider has one (list models or
  voices, account lookups, Azure's token endpoint); Google STT and custom STT/TTS transcribe a tenth of a second of silence or
  speak one word.
- Network: vendor adapters call their fixed hosts; addresses an admin typed (custom LLM/STT/TTS base URLs, Kokoro, VoiceStudio,
  S3-compatible endpoints) are checked public https at save time and called through `safeFetch`, whose connection resolves through
  `publicLookup` (the address checked is the address connected to: no DNS rebinding) and never follows redirects. SMTP hosts are
  resolved, checked, and connected to by the checked IP with the host name for TLS.
- Secrets: sealed per connection, opened per request on the server, never returned (hints only), removed from test results and
  usage errors (`redact` with the known values, `scrubSecrets` for unknown ones), and kept out of the log by Fastify's `redact`
  paths. `AI_CREDENTIALS_KEY_PREVIOUS` lets the server secret rotate: rows open with either and are sealed again with the new one.
- Dashboard: `/settings` (sections General (workspaces, organization, profile), Provider overview (defaults per type), AI Providers (LLM/STT/TTS), Voice & Telephony, Messaging, Email, Storage,
  Employee tools, API Keys, Credentials & audit, Developer; `components/providers/`), the employee page's Providers card and the workflow
  page's Providers sheet (overrides), a phone-account choice when adding a number, an account choice on the WhatsApp channel.

### Adding a provider

1. Write the adapter behind the type's interface (`AIProvider` via a `VENDORS` entry if OpenAI-compatible, `STTProvider`,
   `TTSProvider`, `TelephonyProvider`, `WhatsAppProvider`, `EmailSender`, `ObjectStorage`) with an injectable `fetch`, throwing
   `ProviderError` (kind from `kindOfStatus`) and never putting a secret in a message.
2. Add a `PROVIDER_CATALOG` entry: id, type, name, capabilities, credential fields (secret) and config fields, docs URL, notes.
   `status: "supported"` only with a working adapter; otherwise `coming_soon` and no registry entry.
3. Add a registry entry: `build(conn)` from `conn.credentials`/`conn.configuration` (typed addresses use `conn.userFetch`) and
   `test(conn, signal)` with the cheapest call that proves the key.
4. Test it with a fake `fetch` (see `speech-adapters.test.ts`, `storage-email-adapters.test.ts`); `provider-settings.test.ts`
   checks that every supported catalog entry has a registry entry. Nothing in the dashboard changes: forms come from the catalog.

## Usage, limits and billing (Phase 16)

```
facts already recorded             meter (apps/api/src/billing/meter.ts): INSERT ... SELECT ... ON CONFLICT ("id") DO NOTHING
  AiUsage (LLM, STT, TTS, email,      -> provider       quantity tokens / seconds / characters / sends; costUsd = provider cost, else
           telephony attempts)                          BILLING_PRICE_* on the platform's providers; amountUsd = cost x (1 + BILLING_MARKUP)
                                                        on the platform's providers, 0 on own keys and telephony attempts, null if unknown
  Conversation (not "evaluation")    -> conversation
  ConversationMessage ASSISTANT      -> message
  Call with durationSec, ended 10+ min ago -> voice_minutes  ceil(seconds / 60); priced per minute on the platform's lines
  ToolExecution SUCCEEDED / FAILED   -> tool_call
  WorkflowExecution                  -> workflow_run
when: a limit check (15 min back), billing reads (period start, at most 3 days back), invoice.created (the period),
      the usage-meter schedule every 5 minutes over every organization (3 days back; a timer without Inngest)
limits (billing/service.ts check, a UsageLimiter): plan = BillingAccount.plan while the subscription is active/trialing/past_due,
      else Free; period = the subscription's, else the UTC calendar month; employees and storage counted live, the rest from the
      ledger. Enforced only when billing is on (Stripe configured); a failed check is logged and allowed.
  runTurn: conversations (new), messages, aiUsageUsd -> error event kind "limit", nothing saved (every channel)
  ToolExecutor: toolCalls -> DENIED      employees: create/duplicate/unarchive -> 402      knowledge upload: storageMb -> 402
  calls: voiceMinutes -> inbound "cannot take calls" and hang up, outbound 402
Stripe (billing/stripe.ts, the only Stripe code): Checkout (subscription, client_reference_id + metadata = organization) ->
  webhook: checkout.session.completed / customer.subscription.* -> GET the subscription -> plan by price id, status, period
  invoice.created (subscription_cycle, draft) -> UsageCharge (once per period) -> invoice item (Idempotency-Key usage-<charge>)
  invoice.* -> BillingInvoice upsert
```

- Plans live in `PLANS` (`packages/shared/src/billing.ts`): name, monthly price shown, limits. The Stripe Price per paid plan
  comes from `STRIPE_PRICE_<PLAN>`; a subscription on an unknown price counts as Free (logged).
- Test apps never use the `.env` Stripe keys; `buildApp({ billing: { stripe, enforced, meter } })` passes a fake Stripe `fetch`.
- Tenant analytics (`apps/api/src/reports.ts`): organization from the session, an optional workspace that must be its own,
  regression replays left out; latency percentiles and the daily series in SQL.
- Dashboard: `/billing` (tabs Plan, Usage, Invoices, Limits) and `/reports` (date range, workspace filter), in the sidebar.

## Public API, API keys and webhooks (Phase 17)

```
contract   packages/shared/src/public-api.ts: zod schemas of every public object and request, PUBLIC_ROUTES (method, path, scope,
           schemas, status, idempotent), WEBHOOK_EVENT_DATA, openApiDocument() -> GET /v1/openapi.json. Written by hand, never
           derived from internal types: changing it is a breaking change for customers (add fields, never rename within /v1).
request    /v1 plugin (apps/api/src/public/routes.ts): verifyKey (prefix -> row, SHA-256 compare, revoked/expired, IP allowlist
           against req.ip (TRUST_PROXY behind a proxy), per-key requests per minute (in process; 429 + Retry-After), last use)
           -> scope -> params/query/body parsed -> handler (organization and workspace from the key; writes act as `api:<key id>`
           through the same functions the dashboard routes use) -> response parsed with its schema (unknown fields dropped) -> sent;
           `stream` routes send each event as SSE, parsed the same way. Idempotency-Key on the writes marked idempotent: first answer
           stored and replayed (Idempotent-Replayed: true); a failed request leaves nothing. Errors { error: { type, message, issues? } },
           request-id and x-ratelimit-limit/remaining/reset headers on every answer.
mapping    apps/api/src/public/serialize.ts: the only code that knows rows and the contract (enums lower-case, ISO dates,
           roles customer/employee/agent, startedBy api/webhook/dashboard).
webhooks   apps/api/src/public/webhooks.ts: every 5 s in each API process without Inngest; with Inngest the `webhook-sweep` schedule
           every minute (up to 20 rounds of 25 deliveries); never in test apps, and the server never touches `org_test_` organizations:
           scan: one SQL from each endpoint's cursor (`scannedAt` - 10 min, at most 7 days back, never before the endpoint existed) over
                 Conversation (started, resolved), ConversationMessage (received = USER, sent = ASSISTANT/AGENT), WorkflowExecution
                 (started, finished COMPLETED/FAILED), Handoff, Call (ended), EmployeeRelease (employee.published), CustomerMemory and
                 CustomerProfile (customer.updated, one per customer per scan), in workspaces with an enabled endpoint subscribed,
                 without a delivery yet -> objects mapped with serialize.ts -> WebhookDelivery per endpoint (createMany skipDuplicates
                 on endpoint + event id); the cursors move when a scan found fewer than 500 (else the next scan continues)
           deliver: claim due rows (lockedUntil, SKIP LOCKED) -> POST via safeFetch, 10 s, headers webhook-id (= event id),
                 webhook-timestamp, webhook-signature (v1, HMAC-SHA256 of id.timestamp.body with the whsec_ secret; during a secret
                 rotation two space-separated signatures, new and old) -> 2xx succeeded;
                 else retry after 1 min, 5 min, 30 min, 2 h, 5 h, 10 h, 24 h, then failed; every attempt logged on the row
```

- Routes: `GET|POST /v1/employees`, `GET /v1/employees/{id}`, `POST /v1/employees/{id}/versions` (fields given replace the latest
  version's; instructions = systemInstructions, timeZone = workingHours.timezone), `POST /v1/employees/{id}/publish` (default latest),
  `POST /v1/employees/{id}/messages` (the published version answers on the `api` channel, whole reply, `held` while people have it, 402 at
  a plan limit), `POST /v1/employees/{id}/messages/stream` (SSE: text, done, error), `GET /v1/conversations[/{id}]`,
  `POST /v1/conversations/{id}/resolve`, `GET /v1/customers[/{id}]`, `PUT|DELETE /v1/customers/{id}/memories/{key}` (extraction's
  validation, profile follows identity keys, audited), `GET|POST /v1/knowledge/sources`, `GET /v1/knowledge/sources/{id}`,
  `POST /v1/knowledge/sources/{id}/documents` (base64, 10 MB; the dashboard's upload path), `POST /v1/knowledge/search`,
  `GET /v1/workflows[/{id}]`, `POST /v1/workflows/{id}/executions` (202), `GET /v1/executions[/{id}]`, `GET /v1/tools`,
  `GET /v1/tools/executions`, `GET /v1/analytics?from&to`. Lists: `limit` (1-100) and
  `cursor` -> `{ data, nextCursor }`, newest first by creation.
- Conversations started through the API have channel `api`: in the inbox like any other; agents' replies are not sent anywhere (the
  integration reads them, or gets `message.sent`). API customers are keyed with `normalizeCustomerId`, so they are the same customers
  as on calls, WhatsApp and web chat.
- SDK (`packages/sdk`): `createClient({ apiKey, baseUrl, fetch, maxRetries })` with one method per operation, typed by `src/types.ts`
  (generated from the contract by `generate.ts`; a test fails when it is stale), no imports outside the package; retries reads and
  writes with an Idempotency-Key (it adds one) on network errors, 429 (Retry-After) and 5xx; `paginate`; `streamMessage` (SSE);
  `WorkforceError`; `verifyWebhook(body, headers, secret)` (Web Crypto, 5-minute tolerance, several signatures allowed). `pnpm build`
  compiles `dist/` (`tsconfig.build.json`); `publishConfig` points the published package at it. Python (`packages/sdk-python`): the
  same operations with Python names, urllib only, `verify_webhook`.
- Dashboard: Settings > API Keys and Settings > Webhooks (`components/developer/developer-api.tsx`): create (permissions, rate limit,
  addresses, expiry), edit, rotate with a grace period, revoke, the developer activity log (admins); endpoints with events, on/off,
  send test, rotate secret, deliveries (filter by event, load more) with payload and attempts, send again. Secrets are shown once.

## Conversation intelligence (Phase 15)

```
customer messages -> packages/agent-runtime/src/
  language.ts   detectLanguage: Indian scripts by Unicode block; Roman-script Hindi (Hinglish) by its common words; codeSwitched
                when a message mixes scripts or Hindi and English words; languageProfile: per message, switches, primary
  entities.ts   extractEntities(text, { region, timezone, now }): Indian digits -> 0-9, then spans claimed in order (email, UPI,
                GSTIN, Aadhaar/PAN masked, IFSC, order ids, phones, dates, times, amounts, addresses + PIN, names, payment methods);
                parseAmount (lakh, crore, k); regionOf(employee) = "IN" for Asia/Kolkata or en-IN / hi-en
  insights.ts   analyzeConversation: phrase lists (English, Devanagari, Hinglish) for sentiment (with negation), intent,
                resolution ("ho gaya", "got it") and escalation ("consumer court"); + status and Handoff rows
read: GET conversation detail -> insight; GET /workspaces/:id/insights -> per conversation, then counted (newest 2,000)
runTurn: buildContext -> systemPrompt(..., customerMessage): reply in the customer's latest language and script; Indian
         formats only when regionOf(employee) is IN; never infer a customer's background
```

- Nothing is stored and no model is called: insights are recomputed on every read, so improving a phrase list applies to old
  conversations too. Relative dates use the message's own time in the employee's time zone.
- Region is operational context from the employee's settings (time zone, language variant), never from a customer's number or
  language. Languages are reported as languages, not nationalities.
- Speech: employee languages `en-IN` and `hi-en` (Hinglish). `isoOf` / `isMixedLanguage` / `localeOf` (shared) map them per
  provider: Deepgram `multi` for Hinglish, en-IN as is; AssemblyAI files `language_detection`; Whisper no language for Hinglish;
  ElevenLabs no `language_code` for Hinglish; Google/Azure `hi-IN`; Cartesia ISO. Fixed call lines exist in English, Hindi and
  Hinglish (`LINES_BY_LANGUAGE` in voice/session.ts). `forSpeech` says ₹ amounts in lakh/crore and reads +numbers digit by digit.
- Dashboard: the conversation page's Conversation insights card (`components/inbox/conversation-insight.tsx`) and the Analytics
  page's Conversation intelligence section.

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
- Providers live in `packages/ai-provider/src`, registered in `PROVIDERS` in `index.ts`; the platform's is chosen
  by `AI_PROVIDER`, and the router (above) chooses per request. `openai-compatible.ts` serves any OpenAI-style endpoint (OpenRouter uses it);
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

## Email (Resend)

```
customer -> Resend (receiving on the domain) -> POST /channels/email/resend/webhook (Svix-signed) email.received
         -> GET /emails/receiving/{id} (body; HTML turned to text) -> InboundMessage per recipient address
            (support+<conversation id>@... -> address + threadTag) -> channelService.receive -> job -> answer
reply    -> POST /emails: from "<employee name> <channel address>", subject "Re: ...", In-Reply-To the customer's
            Message-ID, Reply-To support+<conversation id>@..., Idempotency-Key = the outbound log row id
receipts -> email.sent / delivered / opened / bounced / failed -> SENT / DELIVERED / READ / FAILED by Resend's email id
```

- `resendEmail` (`packages/channels/src/email-resend.ts`): send (429 `rate_limit_exceeded` retried; with the key also
  network errors and 5xx), `readWebhook` (Svix check, 5 minutes; a received email that cannot be fetched throws, so the
  webhook answers 502 and Resend retries). Recipient addresses no employee uses are dropped.
- The `send_email` tool and workflow Message steps use a `Mailer` (`packages/tools/src/types.ts`) the API builds from
  Resend and `RESEND_FROM`, with the tool execution id or the step's idempotency key as the `Idempotency-Key`. Without
  Resend or `RESEND_FROM`, both stay in test mode (`testMode: true`).
- Config: `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET`. Test apps never use the `.env` key;
  `buildApp({ email: { resend, from } })` passes a provider with a fake `fetch`.

## Background jobs (`apps/api/src/jobs.ts`)

```
knowledge/document.uploaded  { documentId }                 processDocument (records READY or FAILED itself)
memory/exchange.saved        { tenant, customerId, conversationId, replyId }   loads the exchange, MemoryService.remember
channel/message.received     { messageId, queueKey }        channelService.answerRecorded; one at a time per queueKey
workflow/run.due             { executionId }                loop: step.run(engine.runOne) -> step.sleepUntil(next runAt)
workflow-sweep               cron, every minute             engine.dueRuns -> workflow/run.due for each
evaluation/requested         { evaluationId }               runEvaluation (claims PENDING; records FAILED itself)
evaluation/dataset.run       { runId }                      runCase per case (skips graded cases), then finishRun
evaluation-sweep             cron, every 5 minutes          queueDueEvaluations -> evaluation/requested for each
usage-meter                  cron, every 5 minutes          meter every organization, 3 days back (Phase 16; in process: after the evaluation sweep)
webhook-sweep                cron, every minute (Inngest only) new webhook events and due deliveries (Phase 17; without Inngest: a 5 s timer)
improvement/analyze          { organizationId, workspaceId } analyzeWorkspace: patterns -> suggestions (never a version)
improvement-analysis         cron, daily 06:00              workspacesWithFailures -> improvement/analyze for each (Inngest only)
```

- `jobs.send(name, data)` queues a job. Backends: **Inngest** when `INNGEST_EVENT_KEY` or `INNGEST_DEV` is set (never
  for test apps), serving the functions at `/api/inngest` (`inngest/fastify`); otherwise **in process**: the handler
  starts at once, not awaited, ordered per `orderedBy` key, and workflows use `engine.startRunner` instead of events
  and the sweep. `buildApp({ jobs })` takes "inngest", "inline" or a factory (tests capture the definitions with it).
- Events carry ids only; handlers read what they need from Postgres. An inbound channel message is stored whole on
  its `ChannelMessage.payload` for the job.
- Idempotency: a channel job answers only a message still RECEIVED; a workflow job claims its run in Postgres
  (`SKIP LOCKED`), so duplicate or retried jobs never run a step twice; document processing replaces chunks; memory
  writes are upserts. Retries: documents 0, memory 1, channels 1, workflows 2.
- Calls and web chat stay in the request (real time); they are not jobs.

## Tests

`apps/api/src/*.test.ts` use `node:test` against the real database with throwaway organization
ids, cleaned up afterwards. Conversation tests inject a fake `AIProvider` through
`buildApp({ provider, embedder, memory, aiTimeoutMs })`; memory tests wrap the real `MemoryService`
to await its background `remember` calls; knowledge tests upload the sample files in
`apps/api/src/fixtures`. `jobs.test.ts` builds the app with a fake queue (`jobs` factory) and runs each Inngest
function's handler with recording step tools. There are no dashboard tests in the repo.
