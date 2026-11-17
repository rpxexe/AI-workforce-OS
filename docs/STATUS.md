# Status

Last updated: 2026-11-17, during Phase 7.

## Phases

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo foundation, tooling, database connection | Done |
| 1 | Clerk auth, organizations, workspaces, roles, dashboard shell | Built; real sign-in flow not yet confirmed by a person |
| 2 | AI Employee CRUD with versioning | Built; verified with Clerk stubbed |
| 3 | Agent runtime, AI provider abstraction (OpenRouter default, Anthropic), conversations, test chat | Built; a real OpenRouter reply confirmed through the API, chat page not yet tried in a browser |
| 4 | Knowledge base and RAG: sources, PDF/DOCX/TXT/CSV upload, pgvector search, retrieval in the runtime, source tracing | Built; confirmed end to end through the API with real OpenRouter models, dashboard pages not yet tried in a browser |
| 5 | Persistent customer memory: customers, profiles, extracted and validated memories, conversation summaries, recall in the runtime | Built; confirmed through the API with real OpenRouter models, test chat customer field not yet tried in a browser |
| 6 | Tool system: registry, permissions (grants), validation, executor with timeouts and retries, audit log; calendar, email (test mode), HTTP request, webhook | Built; the meeting-booking flow confirmed with a real OpenRouter model, Tools card not yet tried in a browser |
| 7 | Real-time voice: Twilio inbound and outbound calls, Deepgram STT, ElevenLabs TTS, the same agent runtime, barge-in, transcripts, call state | Built and passing with a simulated Twilio stream; **a real phone call has not happened yet** (needs the Twilio, Deepgram and ElevenLabs keys in `.env`). Do not start Phase 8 before it does |
| 8+ | Not started | Owner pastes the next phase prompt |

## Open items

- **Real phone call pending.** Fill `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `DEEPGRAM_API_KEY`,
  `ELEVENLABS_API_KEY` and `VOICE_NUMBER` in `.env`, start `ngrok http 4000`, then run
  `PUBLIC_URL=<ngrok url> pnpm --filter @workforce/api try-call` and call the number.

- **Clerk Organizations is disabled** in the owner's Clerk application ("AI Workforce", development
  instance). The app cannot get past "Choose an organization" until it is enabled in the Clerk dashboard.
- **Real signed-in flow untested**: sign-up, creating and switching organizations, and the
  dashboard calling the API with a real session token. Keys are in `.env` and both servers start.
- **Test chat (customer field, tool use line), Knowledge pages and the employee Tools card not exercised in a
  browser**; they typecheck, lint and build.
- **The Anthropic provider's tool calling is untested against the real API** (OpenRouter is the
  configured provider). It follows the SDK docs and typechecks; run `AI_PROVIDER=anthropic LIVE_AI=1 pnpm test` once a key is set.

## Verified so far

- `pnpm typecheck`, `pnpm lint`, dashboard production build: pass.
- Docker Postgres and Redis run via `pnpm infra:up`; all three migrations are applied there.
- 52 API tests against the Docker Postgres (`pnpm test`). Voice (9, simulated Twilio over a real
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

WhatsApp, web chat, email channel, workflows, human handoff
(escalation settings are stored but the runtime does not act on them, nor on working hours),
analytics, billing, model routing. In the dashboard, Customers (the API has read routes), Conversations,
Workflows and Analytics are placeholder pages. Packages other than `database`, `shared`,
`ai-provider`, `agent-runtime`, `knowledge`, `memory`, `tools`, `stt`, `tts` and `telephony`, and
all three workers, are empty stubs.

Also skipped, small: scanned PDFs (no OCR), a queue for document processing (it runs inside the
API process), a vector index (search is exact), a relevance floor on retrieved passages, renaming
knowledge sources, voice: per-organization Twilio accounts (one platform account from `.env`),
call recording, the employee ending a call itself, transfer to a human, DTMF, voicemail detection on
outbound calls, fixed call lines (greeting aside) in languages other than English, a separate call
worker process (calls run inside the API), real calendar and email providers (the calendar is built in, email is test mode
and delivers nothing), webhook signing, an audit log page (API only), human approval before a tool
runs, availability lookup and cancelling or moving meetings, editing or deleting customer memories (no admin routes yet), relevance ranking of
memories (all of a customer's facts are recalled, newest 50), merging one person's identities across
channels, a queue for memory extraction (it runs in the API process after the reply), embedding providers other than OpenRouter, providers other than OpenRouter and Anthropic, summarizing long conversations (the runtime
sends the last 40 messages), deleting or renaming conversations, workspace rename/delete, hard delete of employees, list pagination (capped
at 200 per workspace), avatar image upload (icons only), mirroring Clerk users into our database.

Not installed: Inngest, Cloudflare R2, React Flow, a Redis client, Prettier, Turborepo.

