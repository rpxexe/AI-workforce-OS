# Status

Last updated: 2026-11-25, Phase 17 completed: the items first left out (API writes, streaming, key limits, secret rotation, test events, audit log, catch-up, Inngest delivery, publishable SDK, Python SDK) built.

## Phases

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo foundation, tooling, database connection | Done |
| 1 | Clerk auth, organizations, workspaces, roles, dashboard shell | Built; real sign-in flow not yet confirmed by a person |
| 2 | AI Employee CRUD with versioning | Built; verified with Clerk stubbed |
| 3 | Agent runtime, AI provider abstraction (OpenRouter default, Anthropic), conversations, test chat | Built; a real OpenRouter reply confirmed through the API, chat page not yet tried in a browser |
| 4 | Knowledge base and RAG: sources, PDF/DOCX/TXT/CSV upload, pgvector search, retrieval in the runtime, source tracing | Built; confirmed end to end through the API with real OpenRouter models, dashboard pages not yet tried in a browser |
| 5 | Persistent customer memory: customers, profiles, extracted and validated memories (with the extractor's confidence), conversation summaries, recall in the runtime; admin edit / delete / clear / JSON export of a customer's memory, audited (`CustomerAuditLog`); the Customers list (search) and customer page | Built; confirmed through the API with real OpenRouter models. Memory controls: 8 tests (`customers.test.ts`). **Customers pages and the test chat customer field not tried in a browser**; they typecheck, lint and build. The confidence line in the extraction prompt has not run against a real model |
| 6 | Tool system: registry, permissions (grants), validation, executor with timeouts and retries, audit log; calendar, email (test mode), HTTP request, webhook | Built; the meeting-booking flow confirmed with a real OpenRouter model, Tools card not yet tried in a browser |
| 7 | Real-time voice: Twilio inbound and outbound calls, Deepgram STT, ElevenLabs TTS, the same agent runtime, barge-in, transcripts, call state | Built and passing with a simulated Twilio stream; **a real phone call has not happened yet** (needs the Twilio, Deepgram and ElevenLabs keys in `.env`). Do not start Phase 8 before it does |
| 8 | Visual AI journey builder: React Flow editor, workflow versions, validation (incl. step references), publish/pause, delete (dependency check, confirmation) / restore / duplicate, background engine (Postgres job queue), runs with step records, retry, idempotency keys for steps with outside effects, 12 node types, the lead follow-up example | Built; the example runs end to end in the tests with a faked phone line and model; editor and runs pages checked in headless Edge (desktop and phone width). Started before the real phone call, because the owner pasted the phase |
| 9 | Multichannel: channel abstraction (`@workforce/channels`, normalized inbound/outbound/delivery events), WhatsApp behind one provider interface (Meta Cloud API, Twilio, Telnyx; any of them at once, chosen per number: webhook verification, signatures, text/media/location/buttons, delivery receipts, rate-limit retries, 24-hour window errors, voice notes transcribed, documents read), web chat widget (anonymous or website-verified visitors, streaming), email (inbound webhook, replies in test mode), customers and memory shared across voice/WhatsApp/web chat/email, per-employee channel settings with per-channel tool limits, a message audit log for every channel including voice | Built; 11 tests with fake Meta, Twilio and Telnyx APIs and a fake model (phone call to WhatsApp to web chat with memory and summaries carried over); the widget checked in headless Edge (desktop and phone width). **No real WhatsApp message yet** on any provider, Channels card not tried in a browser |
| 10 | Human + AI collaboration: handoff triggers (customer request, low confidence, policy risk, repeated failure, high-value customer, configured conditions and workflow steps, tool failure), conversation states (AI active, waiting for human, human active, resolved, reopened) with assignment and an unassigned queue, the AI silent while people have a conversation, agents replying on the customer's channel (test chat, web chat, WhatsApp, email), the AI Copilot (reply, summary, memory, citations, next action; logged apart from messages), handoff analytics and response times, the Conversations inbox and Analytics pages, handoff emails to the escalation contact | Built; 10 tests (`handoff.test.ts`, fake model, fake Graph API). **Inbox, conversation, Analytics pages and the new escalation settings not tried in a browser**; they typecheck, lint and build |
| 11 | AI quality control: versioned evaluators (deterministic checks, LLM graders, phrase-based policy rules) over eight dimensions with built-in defaults, an asynchronous evaluation worker (sweep of quiet conversations every 5 min, manual "Evaluate now"), results linked to the conversation, employee version, model and workflow version, failures with quoted evidence, the quality overview (score, pass rate, trend, dimensions, employee and version comparison), regression datasets (cases copied from conversations or written by hand) replayed against an employee version without tools | Built; 6 tests (`quality.test.ts`, fake model). **Quality pages and the conversation Quality card not tried in a browser**; they typecheck, lint and build. **LLM graders not run against a real model yet** |
| 12 | Controlled continuous improvement: failure patterns (an evaluator failing on an employee's live version) -> a model-proposed change to instructions, personality or goals with its evidence -> a person creates the proposed version and replays the employee's regression suite on both versions (fixed and broken cases) -> human approval -> percentage rollout (A/B, sticky per customer across channels) with a chosen KPI compared between versions -> promote or roll back; rollback to the previous live version; a release log; version comparison (field-by-field line diff); the Improvements pages and the employee Releases card | Built; 4 tests (`improvement.test.ts`, fake model). **Improvements pages, Releases card and Compare versions not tried in a browser**; they typecheck, lint and build. **The proposal prompt has not run against a real model yet** |
| 13 | Model routing and BYOAI: provider abstraction (OpenAI, Anthropic, Gemini, OpenRouter, custom OpenAI-compatible), organization keys sealed at rest and never returned, a model policy per task (primary, up to 3 fallbacks, cost limit, timeout, allowed providers, order by list / latency / cost), a router that filters by capability, context and cost and falls back without loops, usage records per attempt (provider, model, tokens, cost, latency, success), replies storing the model that actually answered, the AI models page | Built; 11 tests (`routing.test.ts`: the router with fake providers, and the API with the database and faked providers built from keys). **AI models page not tried in a browser**; it typechecks, lints and builds. **No real OpenAI, Gemini or custom endpoint called yet**; Anthropic with an organization's key untested against the real API |
| 14 | Universal provider and integration settings: a provider registry (catalog + adapters + test per provider) over 7 types; organization connections (`ProviderConnection`, Phase 13 keys migrated with their ids) sealed and never returned; 7 more LLMs (Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Hugging Face); STT AssemblyAI (live + files), Whisper, Google, Azure, custom (files); TTS OpenAI, Google, Azure, Cartesia, PlayHT, Kokoro, VoiceStudio, custom; telephony SignalWire plus organizations' own Twilio/Telnyx accounts; WhatsApp on organizations' own Meta/Twilio/Telnyx accounts; email SendGrid, SES, SMTP plus organizations' Resend; storage R2, S3, GCS, Azure Blob, S3-compatible (knowledge uploads); resolution workflow > employee > organization default > platform for LLM/STT/TTS/email; fallback with Phase 13's loop rules for LLM/STT/TTS/email, none on auth/config errors; Test Connection (rate limited, deduplicated); rotation, audit log, disable/default/delete with in-use checks; per-connection webhooks; SSRF pinning; usage and provider metrics per type; the Settings page, employee and workflow Providers overrides | Built; 165 API tests (19 new for Phase 14, 13 speech adapters, 9 email/storage adapters). Plivo, Vonage, SIP and live Google/Azure recognition are listed as coming soon. **No new provider called against its real API yet**; Settings page not tried in a browser |
| 15 | India-first conversation intelligence: language detection (English, Hindi, Hinglish, 8 other Indian scripts) with code-switching and language switches; structured extraction of names, phones (+91 mobiles, landlines, toll-free, international), addresses with PIN codes and landmarks, order/reference ids, dates (day first, Hindi months, kal/parso by tense, weekdays), times (AM/PM, "shaam 5 baje"), amounts (₹, lakh, crore, k), GSTIN, IFSC, UPI ids, payment methods; Aadhaar/PAN only masked; sentiment indicators, intent, resolution and escalation signals in English/Hindi/Hinglish; reply-language guidance per customer message and Indian conventions only for businesses operating in India; new employee languages English (India) and Hindi + English (Hinglish) mapped per speech provider (Deepgram `multi`); Hindi/Hinglish fixed call lines; ₹ amounts and phone numbers formatted for speech; Hinglish/Hindi requests for a person; lakh/crore in handoff thresholds; memory refuses Aadhaar/PAN; the conversation Insights card and the Analytics "Conversation intelligence" section | Built; 14 tests (`insights.test.ts`). **Insights card and Analytics section not tried in a browser**; they typecheck and lint. **Hinglish speech (Deepgram `multi`, ElevenLabs without `language_code`) not tried on a real call**; the analyzers are phrase lists and regular expressions, so expect misses on spellings they do not list |
| 16 | Analytics, usage metering and billing: a usage ledger (`UsageEvent`, one immutable row per source row: provider attempts with cost and the amount billed, conversations, AI messages, voice minutes, tool calls, workflow runs; id `<sourceType>:<sourceId>`, so metering is idempotent), the meter (set-based SQL, before limit checks and billing reads, plus a 5-minute sweep), provider cost x (1 + `BILLING_MARKUP`, set in the server's environment) on the platform's providers only, platform unit prices for speech, calls and email; plans in code (Free, Starter, Growth, Scale) with limits enforced on the server (AI employees, conversations, AI messages, voice minutes, knowledge storage, usage spend, tool calls); Stripe isolated in `billing/stripe.ts` (fetch, no SDK): Checkout, plan changes, the customer portal, signed webhooks re-reading subscriptions, the period's usage added to the renewal invoice once, invoices mirrored; tenant analytics for a date range (`/analytics/report`); the Billing (plan, usage, invoices, limits) and Reports pages | Built; 6 tests (`billing.test.ts`, fake Stripe API). **No real Stripe account used yet**; **Billing and Reports pages not tried in a browser** (they typecheck, lint and build) |
| 17 | Public Developer API and SDK foundations: a hand-written public contract (`packages/shared/src/public-api.ts`: zod schemas, route table, webhook payloads) separate from internal types, `/v1` routes for employees (create, save a version, publish, send a message, stream the reply), conversations (incl. resolve), customers (incl. set/delete a remembered fact), knowledge (incl. create a source, upload a document, search), workflows (incl. starting a run), executions, tools and analytics; API keys per workspace with scopes, SHA-256 hashes only, expiry, rotation with a grace period, revocation, last use, per-key rate limit and IP allowlist, edits; Idempotency-Key on writes; a developer audit log; webhooks for 11 events derived from rows (conversation.started/completed, message.received/sent, workflow.started/completed/failed, human.handoff, call.completed, employee.published, customer.updated) with a per-endpoint scan cursor (catch-up up to 7 days), Standard Webhooks signatures (two during a secret rotation), 8 attempts over ~3 days, test events, a paged delivery log, redelivery, on Inngest when configured; `GET /v1/openapi.json`; `@workforce/sdk` (standalone, generated types, builds to `dist/` for npm) and a Python SDK (`packages/sdk-python`); Settings > API Keys and Settings > Webhooks | Built; 10 tests (`developer.test.ts`, fake model, fake embedder, fake receiver, the Python SDK against the API). **Settings > API Keys and Webhooks not tried in a browser** (they typecheck, lint and build). **No webhook sent to a real receiver yet. Neither SDK published** |
| 18+ | Not started | Owner pastes the next phase prompt |

Also done after Phase 9: **background jobs on Inngest** (document processing, memory learning, answering WhatsApp and
email, workflow runs with sleeps, a one-minute sweep), with the in-process backend kept for tests and development
without Inngest. Verified with a fake queue running each function's handler, and Inngest's own handler serving the 5
functions in dev mode; **not yet run against the Inngest dev server or cloud**.

Also done: **email through Resend** for the email channel (received mail via the `email.received` webhook, fetched by
id; replies threaded by a tagged Reply-To; delivery events), the `send_email` tool and workflow Message steps (from
`RESEND_FROM`), all with idempotency keys. Test mode remains without `RESEND_API_KEY`. Verified with Resend's API faked
(`resend.test.ts`); **not yet sent through a real Resend account**.

## Open items

- **Phase 17 for real.** Production needs `prisma migrate deploy` for `20261124200000_developer_api` and `20261125090000_developer_api_more`
  (not applied to Neon yet). Behind a proxy or load balancer set `TRUST_PROXY` (see `.env.example`) or key IP allowlists see the proxy's
  address. Publishing the SDKs needs an npm scope / PyPI name you own (steps in `packages/sdk/README.md` and `packages/sdk-python/README.md`). Then:
  Settings > API Keys, create a key with all permissions, run
  `curl $API/v1/employees -H "Authorization: Bearer wfk_..."` and send a message with `POST /v1/employees/<id>/messages`. Settings >
  Webhooks, add an endpoint (a request bin such as webhook.site), chat with the employee, check the deliveries and verify one with
  `verifyWebhook` from `@workforce/sdk`; press "Send test" and "Rotate secret". Webhook secrets need `AI_CREDENTIALS_KEY` (503 without it).
  Without Inngest every API process queries the database every 5 seconds for webhooks, even with no endpoints, so a serverless Postgres
  will not suspend while the API runs; with Inngest it is once a minute.

- **Phase 16 with a real Stripe sandbox.** Use a Stripe sandbox (not live mode) and a restricted key (`rk_`, permissions in
  `.env.example`). Create one Product per plan with one monthly USD Price each, set `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_STARTER/GROWTH/SCALE`, add a webhook to `PUBLIC_URL/billing/stripe/webhook` (checkout.session.completed,
  customer.subscription.created/updated/deleted, invoice.*, charge.refunded, charge.dispute.created,
  radar.early_fraud_warning.created; full list in `.env.example`) and put its secret in `STRIPE_WEBHOOK_SECRET`; turn on the customer
  portal in Stripe. Buy Starter from Billing with card 4242..., check the plan, then use Stripe's test clock to reach a renewal
  and check the usage line on the draft invoice. Set `BILLING_PRICE_*` to your providers' prices first, or platform speech and
  calls stay unpriced. Unconfirmed from the docs: that a renewal invoice's `period_start/period_end` is the period just ended
  (the usage window we bill), and that `invoice.created` arrives while the invoice is still a draft for every account setting.
  **Turning Stripe on enforces limits**: the Free plan allows 1 AI employee, so existing organizations over a limit can still
  read everything but cannot add more until they upgrade.
- **Tests run against the local Docker Postgres only** (`pnpm infra:up`, `DATABASE_URL` pointing at it). Neon is production:
  the suite creates and deletes throwaway organizations and, against a remote database, its short waits time out (26-36
  failures on 2026-11-24, all timeouts or knock-ons). Production needs `prisma migrate deploy` for each new migration
  (`20261124100000_billing` was applied to Neon on 2026-11-24).

- **Phase 15 for real.** Set an employee's language to "Hindi + English (Hinglish)" (or its time zone to Asia/Kolkata), chat in
  Hinglish and Hindi in test chat and check the replies keep the customer's script; open the conversation and check the
  Insights card; check Analytics > Conversation intelligence. Place a call with a Hinglish employee: Deepgram should get
  `language=multi` (Nova-3) and the fixed lines should be in Hinglish. Unconfirmed from the docs: Deepgram `multi`
  transcribing Hindi on 8 kHz mu-law phone audio; ElevenLabs Flash reading Roman-script Hinglish without `language_code`;
  Cartesia and PlayHT with Hindi. AssemblyAI live calls stay English-only.

- **Phase 14 for real.** With `AI_CREDENTIALS_KEY` set, open Settings and for each category connect a real account, press Test
  Connection, set it as default, then: test-chat an employee (LLM; check the reply's model and Developer > metrics), give the
  employee a Providers override and chat again, place a call (STT/TTS through the organization's connections), send a workflow
  Message step (email), upload a knowledge file (storage: check the bucket). Phone and WhatsApp on an organization's own account:
  enter the connection's webhook URLs (Settings, Voice & Telephony / Messaging) in the provider's console, add a number choosing
  that account, call it. **Nothing new has been called against a real API**: every adapter follows the vendor's docs and is
  tested against fakes. Unconfirmed from the docs: AssemblyAI's v3 `pcm_mulaw` at 8 kHz and its English-only default model
  (non-English calls will transcribe poorly; pick Deepgram for them); Google STT's Opus sample rate for WhatsApp notes (read
  from the OpusHead); PlayHT's `mulaw` output and language names; Cartesia's `Cartesia-Version` 2025-04-16; SES v2
  `Content.Simple.Headers` for In-Reply-To; GCS interoperability with ListObjectsV2; SignalWire's LaML Media Streams and its
  signature header (Twilio's algorithm with the Signing Key); VoiceStudio's `/v1/audio/voices` shape and whether its
  `/v1/audio/speech` streams (it is asked for WAV and converted). VoiceStudio runs on your machine: expose it over https
  (remote access with `OMNIVOICE_API_KEY`, behind a TLS tunnel), never plain localhost.
- **OmniDimension calling (added 2026-11-23) against the real API.** Connect it in Settings > Telephony (API key + agent id),
  Test Connection, add an OmniDimension number of that account to an employee choosing that connection, place a call, and
  check the call's status, transcript, conversation and customer summary afterwards. Tested only against a fake API
  (`voice.test.ts`). Unconfirmed from the docs: whether `__post_call_actions.webhook` needs `enabled: true` (we send it),
  that `interactions[].time` and `start_time` are UTC, and that `/phone_number/list` returns every number in one page of 150.
- **Phase 14 dashboard in a browser**: the Settings sections, connect/configure/test/rotate/default/disable/delete, the employee
  Providers card, the workflow Providers sheet, the phone-account and WhatsApp-account choices.

- **Phase 13 for real.** Set `AI_CREDENTIALS_KEY` (32+ random characters) in `.env`, restart, add a key in Settings > AI Providers > LLM (e.g.
  OpenAI), on Model routing set the Conversations policy to that model with the platform as fallback, test-chat an employee, and check the reply's
  model and the Usage tab. Then make the key hit a rate limit and see the fallback answer and the failed attempt (since Phase 14 a wrong key fails the turn instead of falling back).
  Unconfirmed from the docs: Gemini's OpenAI-compatible endpoint returning usage in streams (`stream_options.include_usage`);
  older OpenAI models accepting `max_completion_tokens` (we always send it to OpenAI).

- **Phase 12 in a browser and with a real model.** Get an evaluator failing at least 3 times on a live version (Phase 11
  steps; the tone or policy evaluators are the easiest to trip), press "Find improvements" on Improvements, open the
  suggestion, check the evidence and the diff, "Create version and test", wait for both runs, approve, start a 10% rollout,
  change the share, promote, then "Roll back to vN" on the employee's Releases card. Check Compare versions from the Versions
  table. Without Inngest the daily analysis does not run (press the button); with Inngest it runs at 06:00 UTC.

- **Phase 11 in a browser and with a real model.** Open Quality (the eight built-in evaluators appear on first visit), have a
  test chat, press "Evaluate now" on the conversation's Quality card, check the results, then wait 10 minutes after a
  conversation to see the sweep grade it. Make a dataset, add that conversation to it, run it against the live and a draft
  version. Each graded conversation costs four model calls with the default evaluators (correctness, grounding, tone,
  resolution); turn LLM evaluators off on the Evaluators tab to save money.

- **Phase 10 in a browser.** Sign in, open Conversations, test-chat an employee with escalation on ("Can I talk to a
  human?"), take it over from the inbox, reply, ask the Copilot, return it to the AI; check Analytics. The assignee list
  comes from Clerk's organization members (`useOrganization`), which needs Organizations enabled (see below). The
  web chat widget's polling for agent messages is tested through its endpoints only, not in a browser.

- **Inngest end to end.** Set `INNGEST_DEV=1` in `.env`, run `pnpm inngest:dev` next to `pnpm dev`, upload a document,
  start a workflow with a Wait step, send a test-chat message with a customer, and watch the runs at
  http://localhost:8288. Starting the dev server from this session was not permitted, so it has not been done.
  Production needs `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` and the app synced at `PUBLIC_URL/api/inngest`.

- **WhatsApp against a real provider.** Pick one: Twilio (the voice account's keys; a WhatsApp sender, or the
  sandbox), Telnyx (`TELNYX_PUBLIC_KEY` added; a WhatsApp number on the account) or Meta (`META_WHATSAPP_ACCESS_TOKEN`,
  `META_APP_SECRET`, `META_WHATSAPP_VERIFY_TOKEN`). Then `PUBLIC_URL` (ngrok), the provider's webhook URL from the
  Channels card entered in its console, and the number (Meta: Phone number ID) saved on the card.
  Unconfirmed from the docs: Meta's typing indicator on read receipts; **Telnyx's inbound WhatsApp payload** (its
  docs show it only in part: we read `payload.body` as Meta's message object, falling back to the SMS-style
  `payload.text`/`payload.media`), which Telnyx delivery event names carry WhatsApp statuses, whether its hosted media
  URLs need the API key (we send none), and whether `type: "WHATSAPP"` and `webhook_url` are accepted on sends.
  Twilio: whether inbound webhooks ever carry `MessageStatus` (we tell receipts apart by `?event=status` on our own
  callback URL instead).
- **Resend against the real API.** Needs `RESEND_API_KEY`, `RESEND_FROM` and a verified domain with receiving on
  (MX), a webhook to `PUBLIC_URL/channels/email/resend/webhook` with its secret in `RESEND_WEBHOOK_SECRET`, and the
  employee's address on that domain. Unconfirmed from the docs: the JSON of errors (we read `name` and `message`),
  the fields of delivery events beyond `data.email_id`, the received email's header keys (we look up `in-reply-to`
  case-insensitively), and whether every mail client replies to `Reply-To` with the tag kept (threading falls back to a
  new conversation, with the customer's memory, if not). The JSON hook `POST /hooks/email/:channelId/:token` remains for
  other inbound services.
- **Channels card and message log not tried in a browser**; they typecheck and lint. The widget itself was.

- **The example workflow on a real line** needs the voice keys below, an employee with a phone number, the
  calendar tool and a published version. Start it by POSTing a lead to the webhook URL shown on the trigger
  (`{ name, phone, email, preferredDate, preferredTime }`).

- **Real phone call pending.** The Twilio trial gives no number any more, so Telnyx was added (2026-11-19):
  its pretrial account has one free US number (calls only to and from the verified number, 10 minutes,
  reclaimed after 30 days without upgrading). Fill `TELNYX_API_KEY`, `TELNYX_APP_ID` (a TeXML
  Application), `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` and `VOICE_NUMBER` in `.env`, start
  `ngrok http 4000`, check `try-call --numbers`, then run
  `PUBLIC_URL=<ngrok url> CALL_TO=<verified number> pnpm --filter @workforce/api try-call`.
- **Telnyx is untested against the real API.** Unconfirmed from the docs: the account id lookup
  (`/v2/user_profile`), whether outbound calls return a call id, and the media stream fields. The
  test fakes Telnyx's REST calls.

- **Clerk Organizations was enabled by the owner** (2026-11-19) in the Clerk application ("AI Workforce", development
  instance). Signing in, creating an organization and the inbox's member list have not been tried since.
- **Real signed-in flow untested**: sign-up, creating and switching organizations, and the
  dashboard calling the API with a real session token. Keys are in `.env` and both servers start.
- **Test chat (customer field, tool use line), Knowledge pages and the employee Tools card not exercised in a
  browser**; they typecheck, lint and build.
- **The Anthropic provider's tool calling is untested against the real API** (OpenRouter is the
  configured provider). It follows the SDK docs and typechecks; run `AI_PROVIDER=anthropic LIVE_AI=1 pnpm test` once a key is set.

## Verified so far

- Phase 17, the additions (`developer.test.ts`, 5 more tests). Key settings: addresses and ranges (IPv4, IPv6, IPv4-mapped), a bad
  address 400, a key fenced to another network 403 from 127.0.0.1 and working after an edit (members 403 on edits), expiry at creation
  (30 days, status expiring), 3 requests a minute then 429 `rate_limited` with Retry-After and counting `x-ratelimit-*` headers, rotation
  keeps the limit; the developer audit log (admins only) lists every key and endpoint action and never a secret, other organizations see
  only their own. Writes through the SDK: an employee created (draft, version 1, en-IN, Asia/Kolkata), an invalid time zone 400 on
  `timeZone`, an empty change 400, a version with new instructions keeping the time zone, published (active, v2, release by `api:<key>`),
  a key without employees:write 403; a streamed reply (text, done) and a 404 before the stream; resolve twice; customer memory set (lead
  kept on update, confidence 1), identity `name` reaching the profile and cleared on delete, a card number 400, delete then 404, audited
  as `api:`; a knowledge source, a duplicate 409, a TXT upload processed to ready (fake embedder), an .exe and non-base64 400;
  employee.published (version 2, publish) and customer.updated events. Webhooks: a test event delivered at once and verified, members 403;
  secret rotation with 1 hour sends two signatures and both secrets verify, with 0 only the new one does; an endpoint whose cursor is 3
  hours old gets a call that ended 2 hours ago and not one from 8 days ago, and the cursor moves; the delivery log pages by cursor and
  filters by event. The SDK's generated `types.ts` equals what the contract generates. The Python SDK (real HTTP to the app) lists
  employees, sends and streams a message, gets 403 `permission_denied`, verifies a Node-signed webhook and refuses a changed body.
  The built SDK (`dist/`) type-checks and imports as an installed package.

- Phase 17 (`developer.test.ts`, 5 tests, fake model, fake webhook receiver). Keys: members 403, another organization's workspace
  404, unknown scopes 400; `wfk_<12 hex>_<43>` shown once, only a 64-character hash stored, never listed; no key / a forged secret 401
  (`authentication_failed`), a missing scope 403 (`permission_denied`), `request-id` header; last use and IP recorded; another
  organization's key sees nothing (list empty, get 404, revoke 404); rotation with 1 hour keeps both working, the old one `expiring`
  and linked, not rotated twice (409), stops after its grace ("expired"); rotation with 0 revokes at once; revoke is admin-only and
  idempotent. Endpoints: members 403, private (127.0.0.1) and http addresses 400 with the `url` path, another organization's
  workspace 404, `whsec_` shown once and sealed, never listed. Through the SDK: employees with exactly the contract's fields; a message
  with an Idempotency-Key replayed (same answer, `idempotent-replayed`, one model call); the conversation continues on channel `api`,
  4 messages, the customer normalized (`rahul@example.com`); paging by cursor and `paginate`; 400/404/403 in the public error format;
  analytics with no internal cost fields. Webhooks: started/received/sent events after the endpoint was created, scanning again queues
  nothing, every request verifies with `verifyWebhook` and `webhook-id` = event id; a changed body, a timestamp an hour off and another
  secret are refused; a handoff (explicit request) then a held message, an agent's inbox reply readable through the API, resolve ->
  human.handoff and conversation.completed. Retries: a 500 waits ~1 minute, nothing sent before it is due, then succeeds with the same
  `webhook-id` and two log entries; the last attempt failing gives up; deliveries list by status, other organizations 404 on the log
  and redelivery; redelivery (409 while pending) succeeds. A workflow started through the API (`startedBy: api`, retried
  Idempotency-Key starts nothing) runs to completed with its steps -> workflow.started (as queued) and workflow.completed; a call
  ending -> call.completed with its duration; unsubscribed events and disabled endpoints get nothing; deleting an endpoint deletes its
  deliveries. OpenAPI 3.1 has every route with its operationId and every event under `webhooks`, without a key; unknown /v1 routes 404
  in the public format. Also checked: the server's own webhook timer leaves the test suite's organizations alone (a running
  `pnpm dev` raced the tests before that).

- Phase 16 (`billing.test.ts`, 6 tests, fake Stripe API). Ledger: five AiUsage rows -> five rows with `ai_usage:<id>` ids and
  their source; metering again adds 0; platform LLM cost billed at cost x (1 + markup); own key billed 0; platform STT 120 s priced
  per minute and marked up; telephony attempts billed 0 (the call is); unknown cost unpriced (null) and counted; a 61 s call is 2
  minutes, billed once settled, a call that just ended waits; denied tool calls and regression replays are not usage;
  the usage endpoint's totals and sources, other organizations see nothing, inverted ranges 400. Limits on Free: a second
  employee 402; the 101st conversation refused in the chat stream while an existing conversation continues; the 501st AI
  message refused and nothing saved; the 201st tool call DENIED by the executor; an upload past 50 MB 402; voice minutes
  over 30 refused; the overview's used/limit per key; billing off = no limits. Stripe: members 403 on checkout, the Checkout
  session carries the organization and price, one customer per organization, a plan without a price 503; forged and stale
  signatures 400; checkout completion sets Starter with the subscription's period (and a refused conversation is answered
  again); a plan change moves the subscription's price and Stripe's own event agrees; the renewal draft gets the ledger's
  billed amount once (a redelivered event adds nothing; idempotency key `usage-<charge id>`); invoices mirrored with the
  newest status; the portal (409 without a customer); cancellation returns Free. Report: totals for a range without replays,
  one daily row per UTC day, another organization sees zeros, another organization's workspace 404, inverted or longer than
  366 days 400, signed out 401.

- Phase 15 (`insights.test.ts`, 14 tests; no model). Language: English, Hindi, Hinglish (Roman, and Devanagari with English
  words), Bengali, Tamil, other Latin languages and digits only; switches skip digit-only messages; ties go to the first
  language. Entities in English, Hindi (Devanagari names, Hindi digits, Hindi months, "kal" tomorrow or yesterday by tense,
  "शाम 6 बजे"), Hinglish ("mera naam ... hai", 5 lakh, parso, "shaam 5 baje", "saade 3 baje", agle somvar, GPay, 1.2 crore,
  50k); addresses ending at the PIN code with landmark, PIN codes only with the word; GSTIN, IFSC, UPI id, NEFT; Aadhaar and PAN
  masked everywhere, a +91 number never taken for Aadhaar; landline, toll-free, international. Region from the business's time
  zone or language variant only: a bare 10-digit number gets +91 and an unmarked amount is rupees only then. Conversation
  analysis (Hinglish complaint: negative, order status, with people, "consumer court"; English: positive, pricing, resolved).
  System prompt follows Hinglish/Hindi script, adds Indian conventions only for Indian businesses, never for a +91 caller to a
  US business. Hinglish/Hindi requests for a person; toNumber with lakh/crore. Memory refuses Aadhaar/PAN values and keys, keeps
  postal_code and Devanagari names. Voice: lakh/crore speech, Rs. 999/-, phone digits; Deepgram `multi` for Hinglish, ElevenLabs
  en-IN -> en. API: detail insight for members (entities with message index, +91 from the employee's region), overview counts
  without evaluation replays, 404 for other organizations, 401 signed out.

- Phase 5 memory controls (`customers.test.ts`, 8 tests, no model): extraction keeps a confidence only between 0 and 1. The list
  searches name, email, phone and channel id, case-insensitive; detail carries memory id, confidence, source conversation and each
  conversation's channel and status. Edit: members 403, empty or card-number values 400, the profile follows an identity key,
  confidence becomes 1, one `memory_edit` row naming the key (never the value). Delete: profile field cleared, a second delete 404.
  Clear: facts, profile and summaries gone, conversations kept, counts in the audit row. Export: admins only, attachment header,
  profile + memories + summaries, audited. Another organization's admin gets 404 on all five routes, through their workspace and
  through ours, and nothing changes; a memory id under another customer of the same organization is 404; signed-out 401.

- Phase 14 (`provider-settings.test.ts`, 19 tests; `speech-adapters.test.ts`, 13; `storage-email-adapters.test.ts`, 9; all fakes,
  no real provider). Registry: every supported catalog entry has an adapter and a test, coming-soon entries none, at least two per
  category, live STT only Deepgram and AssemblyAI. Sealing: fresh IV, server secret only, the previous secret while rotating,
  Phase 13's v1 keys open. Redaction of known and unknown secrets. Fallback: each target once (a duplicate is not retried), at most
  3, no fallback on auth or config, one request id; TTS only before audio; live STT moves to the next provider when a stream fails
  before hearing anything, transcribe-only providers never take calls; email only after a rate-limit refusal. Test Connection:
  models listed, an echoed key removed from the error, a missing TeXML app = config invalid, timeouts reported, coming soon
  refused. SSRF: loopback, private, metadata, IPv4-mapped IPv6, http, and a DNS-rebinding host (public at the check, loopback at
  the connection) refused. API: admins only for writes, secrets sealed and never in any response (settings, audit, tests),
  catalog field checks with form paths, unique names, coming soon and unknown providers refused, private/http typed addresses and
  an SMTP localhost refused, 503 without the server secret; Test Connection stored and audited, two simultaneous presses = one
  call, the 11th test in a minute 429, other organizations 404; rotation (hints, rotatedAt, test reset, configure cannot change
  secrets); LLM resolution platform -> default connection -> employee -> workflow, a task policy between overrides and the
  default, disabled connections skipped, overrides must name the organization's own active connections, test chat answered by
  the employee's key with usage naming the employee; a bad key fails the turn instead of falling back; speech resolution
  (default, employee override with its voice, rate-limited override falls back to the default), usage characters; Whisper alone
  cannot answer calls, a live default fills in; metrics per type and provider, isolated; deletion refused while a workflow, a
  policy or a phone number uses a connection, then audited; isolation of connections and overrides; a Twilio connection's
  webhook checked with its own token, its number refused to another organization's validly signed webhook, unknown connections
  404; the Phase 13 migration copies keys with their ids, names, hints, base URLs and models, policies still route to them, and
  v1 keys are sealed again as v2. All Phase 13 tests pass unchanged except that `routing.test.ts` reads the key from
  `ProviderConnection` (the table moved).

- Phase 13 (`routing.test.ts`, 11 tests). Router with fake providers: a failure before any text falls back, both attempts are
  recorded under one request id, `done` names the model that answered; no fallback after text reached the caller or on a
  refusal; at most 3 attempts, a model listed twice tried once; the policy timeout moves on (recorded `timeout`), a cancelling
  caller does not; tools, context, cost (unknown price skipped under a limit) and allowed providers rule models out, and when
  none is left the error lists each reason and one `none` row is recorded; cheapest and fastest orders (unmeasured models get
  one turn), a model that just failed goes last, provider-reported cost wins over the estimate. Keys sealed with AES-256-GCM
  (fresh IV, wrong secret fails). Through the API: keys admin-only, custom providers need a public https base URL (127.0.0.1 and
  http refused), the key never appears in any response, `keyHint`, unique names, a blank key keeps the stored one, the
  provider cannot change, other organizations get 404; 503 without `AI_CREDENTIALS_KEY`. Test chat: platform without a policy;
  with a chat policy the organization's key answers (the provider got the opened key, the reply stores `claude-opus-5-5`); a
  rate-limited key falls back to the platform (reply stores `fake-1`); usage rows (task, attempt, provider, model, credential,
  success, error kind, workspace, cost estimated from Anthropic's prices); the usage summary (calls, failures, fallbacks, cost,
  by model) and its isolation; a key in use cannot be deleted; another organization's key refused in a policy; the default
  policy covers chat; an allowed-providers list nothing matches fails the turn with a clear error.

- Phase 12 (`improvement.test.ts`, 4 tests, fake model): proposals keep only instructions, personality and goals, must
  validate and differ (no change, declines, non-JSON, oversized refused); KPI verdicts (not enough data under 10 a side,
  improved, no clear difference, worse); rollout buckets are stable, about the share, raising the share keeps everyone already
  on the candidate, no customer key means the published version. End to end: three test chats fail the tone grader on v1, the
  analysis (admins only) writes one suggestion with the evidence and quotes and creates no version; the model saw the
  instructions, the counts and the quotes; analysing again adds nothing. Approval refused before tests (409) and for members
  (403). "Test" creates v2 (production stays v1), the 3 failing conversations become suite cases, both runs finish: 3 fixed,
  0 broken. Unapproved v2 cannot be published or rolled out (409). Approve once. Rollout at 50%: one at a time, publishing
  blocked while it runs, customers inside the share get v2 and outside v1 (through the channels' `liveEmployee`), 100% gives
  everyone v2. KPI from production evaluations: improved, sample counts (control includes the baseline before the rollout).
  Promote publishes v2 and logs it; rollback publishes v1 and then has nothing earlier; a rolled-back rollout leaves everyone
  on v1; stages follow (rolling out, released, rolled back). Other organizations get 404 on every route.

- Phase 11 (`quality.test.ts`, 6 tests, fake model): the grade parser (scores rounded, null = skipped, out-of-range and
  non-JSON = error); phrase rules match whole words in any case, regex characters stay literal, forbid and require;
  tool success, reply latency and escalation checks (an ignored request for a person fails, a handoff picked up in time
  passes, one left open past the limit fails, nothing to judge = skipped). Evaluators: 8 defaults created once even on two
  simultaneous first visits, saving adds version 2 and makes it current, the switch, validation paths, members 403 on
  writes, other organizations 404. A test chat is not graded during the turn; "Evaluate now" (admins) queues it, the job
  grades it with links to employee version 1 and model `fake-1`, the policy rule fails quoting "I guarantee", the tone
  grader's finding and score are stored, tool and escalation checks are skipped, score = average of scored results,
  failures counted; each LLM grader saw the rubric, the employee's configuration and the numbered transcript. Failures
  list and dimension filter, the overview (trend days, dimensions, employee and version comparison, top failures),
  evaluator 30-day stats. The sweep skips conversations not quiet long enough, grades once per conversation state (a
  duplicate job does nothing), and again after a new message. The workflow version is found from an AI Employee step's
  output. Datasets: case copied from a conversation, synthetic case, validation, run against v1: one case passes, one
  whose second turn fails is FAILED with the reason, expectations reach the graders, no registry tools offered; replays
  are on the `evaluation` channel and stay out of the inbox, the employee's test chats, the failures list and the sweep;
  delete; isolation.

- Live call transfer (`voice.test.ts`, simulated Twilio stream and signed webhooks): "Can I speak to a person
  please?" on a call to an employee with a transfer number: the handoff line, "I'm connecting you now. Please hold.",
  an INITIATED `CallTransfer` row (with conversation and handoff), then the provider is asked to dial with the result
  URL; the call is not marked ended when our stream closes. Answered (`DialCallStatus=completed`, 240 s): COMPLETED with
  the talk time, conversation human active, handoff accepted, `<Hangup/>`; a retried result changes nothing; the
  status callback ends the call. No answer: the callback line, NO_ANSWER, the conversation still waiting. Forged
  results 403. Provider refuses: FAILED with its error, the callback line, hang-up. Transfers in the call detail and
  the inbox conversation. **Not tried on a real call**: Twilio's modify-call `Twiml` and `<Dial action>` are
  documented; **Telnyx's update-call `Texml` parameter and its `<Dial action>` fields are assumed** from TeXML's
  Twilio compatibility; the caller ID the person sees is the provider's default (the caller's number on inbound calls).

- Phase 10 (`handoff.test.ts`, 10 tests, fake model, fake Meta Graph API, real memory service): "Can I talk to a
  human?" hands off without a model call and lands in the unassigned queue; messages while waiting are saved and not
  answered (`held`); a member (not only admins) takes over and replies; returned to the AI, the model gets the whole
  conversation (the agent's message as the employee's, held messages joined) and a note about the human colleague;
  resolved then written to again: reopened, the AI answers. The transfer tool for low confidence and policy risk (offered
  with registry tools, its guidance in the prompt); a failed tool hands off after the reply explaining it; two failed
  turns in a row hand off; a high-value customer (budget "$80,000" >= 50000) and a "refund" condition hand off once per
  conversation; a workflow handoff only once. Web chat: `held` event, inbound row HELD, the session reports the state,
  the agent's message polled by the widget's endpoint (forged sessions 401), resolved then reopened by the AI. WhatsApp:
  a message to a conversation with people is HELD and nothing is sent; the agent's reply goes out through Meta. Copilot:
  summary, reply, next action, memory facts, stored apart from messages, "use" recorded (`usedInMessageId`, not edited).
  Assignment and the queue, unassign back to the queue, 409 on impossible moves, 400 on unknown actions, other
  organizations 404, phone-call conversations cannot be replied to by text. Analytics: every trigger counted, outcomes,
  take-over and first-reply times, AI and human reply times, per agent, Copilot use.

- Phase 9 (`channels.test.ts`, 9 tests, fake Graph API, fake model, real memory service): a phone-call turn teaches
  name and budget, then a WhatsApp message from the same number (WhatsApp writes it without "+") reaches the same
  customer, the prompt has the facts and the call's summary, the reply goes to Meta and is logged SENT, the message is
  marked read, the next message continues the conversation, a retried webhook is not answered twice; web chat with a
  website-verified phone number (formatted differently) sees the call and WhatsApp summaries; forged identity hashes,
  other websites' origins and forged session tokens are refused. Delivery receipts only move forward, failures carry the
  meaning of Meta's code. Rate limits (130429) are retried, the 24-hour window (131047) is not. Voice notes transcribed,
  documents read, images described, unsupported types answered politely, reactions ignored. Per-channel tool limits (not
  offered, and refused by the executor if called anyway); anonymous visitors are their own customer; identity-required
  channels refuse them; turned-off channels and paused employees do not answer; over 20 messages a minute are not
  answered. Email: answered in test mode, the quoted part of a reply dropped, replies to our email continue the thread.
  Settings: validation, roles (secrets hidden from members), isolation, one WhatsApp number per employee, the log's filters.
- The widget in headless Edge (Clerk not involved): greeting, a streamed reply, the visitor id kept, history after a
  reload, dark mode, desktop and 390 px wide.

- `pnpm typecheck`, `pnpm lint`, dashboard production build: pass.
- 203 API tests on the local Docker Postgres on 2026-11-25 (Phase 17 complete): 199 pass, 0 fail, 4 skipped (need `LIVE_AI=1`).
- 198 API tests on the local Docker Postgres on 2026-11-24 (Phase 17 included): 194 pass, 0 fail, 4 skipped (need `LIVE_AI=1`).
- 193 API tests on the local Docker Postgres on 2026-11-24 (Phases 15 and 16 included): 189 pass, 0 fail, 4 skipped (need `LIVE_AI=1`), in 2 minutes.
- Docker Postgres and Redis run via `pnpm infra:up`; all migrations, including `channels`, are applied there.
- 161 API tests (Phase 14 included; 4 more need `LIVE_AI=1`), all passing on 2026-11-20. Earlier: 120 at the end of Phase 13. Earlier: 109 at the end of Phase 12. Earlier: 105 at the end of Phase 11. Earlier: 98 on 2026-11-19. Earlier: 75 API tests against the Docker Postgres (`pnpm test`; 4 more need `LIVE_AI=1`). Workflows (12, fake model, fake Twilio, fake network,
  the real background runner): the example end to end (webhook trigger, outbound call placed with the templated
  greeting, run waits for the call, the AI condition reads the transcript, the calendar books the lead's time
  through the tool executor with an audit row, the confirmation uses the booking); the no path; graph validation
  (branches, loops, reachability, settings, triggers); publish refusing invalid versions, unknown employees and
  ungranted tools; versions (save appends, runs keep their version) and Wait; a failure then retry from the failed
  step (attempt 2); CRM Update into customer memory and profile; pause holding a due run, resume releasing it; an
  AI Employee step on the workflow channel; Human Handoff waiting for Continue; roles, isolation, webhook token;
  references to missing, self or not-always-earlier steps; delete refused with a run in progress, then stopping it,
  hook URL 404, restore paused, retry of the stopped run, duplicate; crash re-runs (tool reuses its audited
  outcome without booking again, HTTP resends the same Idempotency-Key, Voice Call follows the placed call without
  dialing, an interrupted AI Employee turn fails). Earlier: Voice (9, simulated Twilio over a real
  WebSocket in Twilio's message format, fake STT/TTS/model): a call from greeting to hang-up (audio
  reaches STT, the caller's turn goes through runTurn with the employee's tools and the phone-call
  style, the calendar tool books, the reply is spoken sentence by sentence, transcript, conversation
  on the voice channel linked to the caller as a customer, second turn keeps the history, status
  callback duration); barge-in (clear sent, unsaved turn carried into the next, line marked
  interrupted); error recovery (apology on a failed reply, polite hang-up when STT is lost, forged
  stream tokens refused); silence check-in and hang-up; webhook signatures, unknown numbers,
  unpublished employees, retried webhooks; outbound calls and their status callbacks; roles and
  isolation; Twilio's published signature example; sentence splitting. Tools (11, with a scripted fake model and a
  fake network): "Book me a meeting tomorrow at 3 PM" end to end (tool offered, called, validated,
  executed, result sent back, reply, event stored at 15:00 in the employee's time zone, audit row);
  invalid arguments refused with the reason and corrected by the model; a taken slot reported as a
  conflict; tools not granted are neither offered nor run; unknown tools, stale grants and other
  organizations denied; email test mode; HTTP host allowlist, GET retried and POST not; webhook
  goes only to the admin's URL with one idempotency key across retries; timeouts not retried;
  unexpected errors hidden from the model; the network guard refuses private and non-https
  addresses; time-zone conversion incl. daylight-saving gaps; grant validation, roles, isolation.
  OpenRouter tool calls (1): tools sent, streamed fragments joined, results sent back as tool
  messages, truncated calls refused. Memory (5, with a fake model): validation
  keeps well-formed facts and drops unknown categories, secrets, card numbers, overlong values and
  non-JSON; facts and the summary persist and reach the prompt of a later conversation; a key
  learned again is replaced; a conversation keeps its customer; organization isolation (same
  customer id in two organizations, API 404s, the service refuses a wrong scope); small talk,
  rejected or failed extractions store nothing and the turn still succeeds; no customer means no
  extraction. Knowledge (5, with fake models): all four
  file types processed, search ranks the answering passage first with document and page, the
  runtime gives attached knowledge to the model and stores the reply's sources, bad files fail
  with a reason, reprocess replaces chunks, delete, role checks, organization and workspace isolation. OpenRouter provider (2, against a local
  stand-in server): streaming, usage, error kinds. Conversations (5, with a fake provider):
  streaming, saved messages and usage, history on later turns, latest version used, provider
  failure and timeout save nothing, validation, role checks, isolation. Employees and workspaces (14): CRUD, versioning, validation, role checks (members get 403
  on writes), isolation (other organization or workspace gets 404 on every route), cascade delete.
- `LIVE_AI=1 pnpm test` adds four tests that call the provider configured in `.env` (skipped
  otherwise, since it spends money). They passed against OpenRouter: a plain reply, and the
  pricing example (upload `fixtures/pricing.pdf`, attach it, ask "What is the enterprise plan
  price?"; the reply said $499 per month and cited pricing.pdf page 2), and memory: "My name is Rahul. I am interested in the enterprise plan and my
  budget is around 50,000." stored exactly `name=Rahul, interest=enterprise, budget=50000`, and in a
  new conversation the employee answered "I remember you're Rahul and your budget is around $50,000".
  Tools: "Book me a meeting tomorrow at 3 PM." made the model (OpenRouter chose
  nvidia/nemotron-3-ultra) call `calendar_book_meeting` with tomorrow's date and 15:00; the event was
  stored at 15:00 Asia/Kolkata and the reply confirmed it.
- With real Clerk keys: API returns 401 when signed out; dashboard pages redirect to `/sign-in`;
  the Clerk sign-in form renders.
- 18-step headless-browser walkthrough of the signed-in UI (desktop and mobile) with Clerk stubbed.

## Deliberately not built yet

Working hours (stored, not acted on), analytics beyond handoffs, response times, quality and improvement KPIs, billing. Packages other than `database`, `shared`,
`ai-provider`, `agent-runtime`, `knowledge`, `memory`, `tools`, `stt`, `tts`, `telephony`, `workflows`, `channels` and `providers`, and
all three workers, are empty stubs.

Also skipped, small: scanned PDFs (no OCR), a queue for document processing (it runs inside the
API process), a vector index (search is exact), a relevance floor on retrieved passages, renaming
knowledge sources, voice: per-organization Twilio accounts (one platform account from `.env`),
call recording, the employee ending a call itself, transfer to a human, DTMF, voicemail detection on
outbound calls, fixed call lines (greeting aside) in languages other than English, a separate call
worker process (calls run inside the API), a real calendar provider (the calendar is built in), webhook signing, an audit log page (API only), human approval before a tool
runs, availability lookup and cancelling or moving meetings, a page for the customer audit log (rows only), editing a memory's key or category, adding memories by hand, customer list paging (newest 200 matches), relevance ranking of
memories (all of a customer's facts are recalled, newest 50), merging one person's identities across
channels, a queue for memory extraction (it runs in the API process after the reply), embedding providers other than OpenRouter, providers other than OpenRouter and Anthropic, summarizing long conversations (the runtime
sends the last 40 messages), deleting or renaming conversations, workspace rename/delete, hard delete of employees, list pagination (capped
at 200 per workspace), avatar image upload (icons only), mirroring Clerk users into our database.

Channels, skipped: outbound WhatsApp templates (needed to write first, or after 24 hours of silence; the error is
logged), sending media from the employee, images and videos seen by the model (described only), email attachments,
per-organization Resend and WhatsApp accounts (one account per provider, from `.env`), a WhatsApp
number picker (the admin types the number or Meta's Phone number ID), read receipts and typing on Twilio and Telnyx,
a provider settings page (credentials stay in `.env`), rotating a web chat identity secret (remove and add the channel),
markdown in the widget (plain text), the widget's look per employee, rate limits per IP on widget sessions,
SMS, Messenger, Instagram, Telegram, merging a customer known by email with the same person known by phone.

Handoff, skipped: real-time push to the inbox and widget (both poll every 4-5 s), notifications other than the escalation email
(none for workflow handoffs or assignments), memory learning from the human part of a conversation (only AI exchanges
are extracted), the employee filter in the inbox UI (the API takes `employeeId`), routing rules or skills for
assignment, SLAs and business hours in response times, editing or deleting a sent agent message, translating the
handoff detection for explicit requests (English phrases in code; the model's transfer tool covers other languages),
inbox paging (newest 100 per view), analytics paging (newest 10,000 handoffs per period).

Workflows, skipped: permanently deleting workflows (delete is soft), cancelling a single run (deleting stops all),
a dependency check when archiving an employee a workflow uses (publishing and the step itself catch it), loops and parallel branches, triggers other
than manual and webhook (no "customer created" or schedule events), automatic per-step retries (retry is manual;
tools keep their own retry policy), Message channels other than email (Resend), SMS,
an external CRM (CRM Update writes our customer memory), notifying anyone about a Human Handoff (it waits on the
Runs tab), webhook signing, run history paging (newest 50), dark mode on the canvas.

Quality, skipped: acting on grades (by design: nothing changes production behaviour), alerts on failures, sampling (every
quiet conversation is graded), grading voice calls from the timed transcript (the conversation's messages are graded),
tools in regression replays (none are offered, so a replay never books or sends), customer memory in replays, comparing
two runs side by side (runs are listed with their scores), deleting evaluators (turn them off), reruns of a FAILED
evaluation other than "Evaluate now", a run that crashed stays RUNNING, evaluator weights (every scored result counts
equally), human labels on results, paging (newest 100 failures, 50 runs, 10,000 evaluations per overview period), the
exact passages a reply was given (graders get the cited pages' current text).

Improvement, skipped: editing a proposed change before its version is created (edit the version afterwards: saving makes a
new one), suggestions written by people (any saved version can be rolled out from the employee page), changes to anything
but instructions, personality and goals (knowledge, tools, channels and escalation are never proposed), automatic rollout
steps or automatic promotion/rollback on the KPI (people decide), more than one candidate per rollout (A/B, not A/B/n),
a regression gate on manual publishes and rollouts of versions not from suggestions (the suite can be run from its dataset
page), the daily analysis without Inngest, KPI paging (newest 10,000 evaluations per side), significance beyond a 95% Welch
test, notifications about new suggestions.

Billing, skipped: plans editable without a deploy (in code), per-organization custom limits or contracts, trials and coupons
(Stripe's portal can apply them, our plan follows the subscription), taxes (GST/VAT; add Stripe Tax or a gateway that does it),
currencies other than USD, usage of a cancelled subscription's last partial period (no renewal invoice to add it to), Stripe
Billing meters (usage is one invoice line per period from our ledger, so another gateway needs no meter setup), stopping a
call already in progress at the voice-minutes limit, limits on workflow runs, memory/Copilot/grader model calls being refused
at the usage cap (they are billed, only customer turns are stopped), corrections to ledger rows (append-only; a refund is
Stripe's), a history of past plan periods (Stripe's invoices are the record), dunning beyond Stripe's own emails.

Developer API, skipped: rate limits shared across API processes (each process counts its own minute), API writes beyond those listed
(deleting employees, editing escalation/working days/tools/channels through the API, deleting documents, editing workflows), events
older than 7 days when first scanned, events for anything not listed, the developer audit log beyond the newest 100 entries, SDKs in
languages other than TypeScript and Python (generate them from `/v1/openapi.json`), publishing either SDK (needs the owner's npm and
PyPI accounts).

Conversation intelligence, skipped: a language model for intent, sentiment or entities (phrase lists and regular expressions,
explainable and free; spellings they do not list are missed), Indian languages other than Hindi beyond script detection (no
Tamil/Telugu/... phrase lists; Marathi and Nepali count as Hindi), number words ("pachaas hazaar"), storing insights (computed
on read; the overview reads the newest 2,000 conversations of the period with their last 100 customer messages), acting on
insights (nothing routes or hands off on sentiment), the agent's and employee's messages (customers' messages only),
month-first dates (day first unless the second number is over 12), Devanagari order-id keywords, fixed call lines in languages
other than English, Hindi and Hinglish.

Provider settings, skipped: Plivo, Vonage, SIP and live Google/Azure recognition (coming soon, listed), AssemblyAI languages other
than English on calls, platform API keys for our own API (the API Keys section says so), webhook signing for our outgoing
webhooks, a KMS (one server secret, rotatable), shared test rate limits across API processes, per-workspace connections and
overrides (organization and employee/workflow only), storage overrides and moving existing files between storages, fallback for
telephony, WhatsApp and storage (by design), built-in prices for speech, calls and email (`costPerUnit` per connection), embeddings
on organizations' connections (the vector column fixes the model), Telnyx voice webhook signatures (the URL token remains),
inbound email on providers other than Resend (the JSON hook remains).

Model routing, skipped: routing embeddings (the 1536-dimension column fixes the model), a "test this key" button (a key is
proven by its first call; failures show on the Usage tab), per-workspace or per-employee policies (organization and task only),
a KMS or key rotation (one server secret), private or http base URLs for custom endpoints (public https only, so no local
Ollama), built-in prices for models other than Anthropic's (entered per key), budgets per period and alerts (only a cost limit
per call), cost known before an OpenRouter call (recorded after), usage paging (newest 100 calls) and export, a shared
latency/cooldown memory across API processes, refusal fallbacks inside a provider (a refusal ends the request).

Not installed: Cloudflare R2, a Redis client, Prettier, Turborepo.

