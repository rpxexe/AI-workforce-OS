# Status

Last updated: 2026-11-19, end of Phase 10.

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
| 8 | Visual AI journey builder: React Flow editor, workflow versions, validation (incl. step references), publish/pause, delete (dependency check, confirmation) / restore / duplicate, background engine (Postgres job queue), runs with step records, retry, idempotency keys for steps with outside effects, 12 node types, the lead follow-up example | Built; the example runs end to end in the tests with a faked phone line and model; editor and runs pages checked in headless Edge (desktop and phone width). Started before the real phone call, because the owner pasted the phase |
| 9 | Multichannel: channel abstraction (`@workforce/channels`, normalized inbound/outbound/delivery events), WhatsApp behind one provider interface (Meta Cloud API, Twilio, Telnyx; any of them at once, chosen per number: webhook verification, signatures, text/media/location/buttons, delivery receipts, rate-limit retries, 24-hour window errors, voice notes transcribed, documents read), web chat widget (anonymous or website-verified visitors, streaming), email (inbound webhook, replies in test mode), customers and memory shared across voice/WhatsApp/web chat/email, per-employee channel settings with per-channel tool limits, a message audit log for every channel including voice | Built; 11 tests with fake Meta, Twilio and Telnyx APIs and a fake model (phone call to WhatsApp to web chat with memory and summaries carried over); the widget checked in headless Edge (desktop and phone width). **No real WhatsApp message yet** on any provider, Channels card not tried in a browser |
| 10 | Human + AI collaboration: handoff triggers (customer request, low confidence, policy risk, repeated failure, high-value customer, configured conditions and workflow steps, tool failure), conversation states (AI active, waiting for human, human active, resolved, reopened) with assignment and an unassigned queue, the AI silent while people have a conversation, agents replying on the customer's channel (test chat, web chat, WhatsApp, email), the AI Copilot (reply, summary, memory, citations, next action; logged apart from messages), handoff analytics and response times, the Conversations inbox and Analytics pages, handoff emails to the escalation contact | Built; 10 tests (`handoff.test.ts`, fake model, fake Graph API). **Inbox, conversation, Analytics pages and the new escalation settings not tried in a browser**; they typecheck, lint and build |
| 11+ | Not started | Owner pastes the next phase prompt |

Also done after Phase 9: **background jobs on Inngest** (document processing, memory learning, answering WhatsApp and
email, workflow runs with sleeps, a one-minute sweep), with the in-process backend kept for tests and development
without Inngest. Verified with a fake queue running each function's handler, and Inngest's own handler serving the 5
functions in dev mode; **not yet run against the Inngest dev server or cloud**.

Also done: **email through Resend** for the email channel (received mail via the `email.received` webhook, fetched by
id; replies threaded by a tagged Reply-To; delivery events), the `send_email` tool and workflow Message steps (from
`RESEND_FROM`), all with idempotency keys. Test mode remains without `RESEND_API_KEY`. Verified with Resend's API faked
(`resend.test.ts`); **not yet sent through a real Resend account**.

## Open items

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
- Docker Postgres and Redis run via `pnpm infra:up`; all migrations, including `channels`, are applied there.
- 98 API tests (Phase 10 included; 4 more need `LIVE_AI=1`), all passing on 2026-11-19. Earlier: 75 API tests against the Docker Postgres (`pnpm test`; 4 more need `LIVE_AI=1`). Workflows (12, fake model, fake Twilio, fake network,
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

Working hours (stored, not acted on), analytics beyond handoffs and response times, billing, model routing. In the
dashboard, Customers (the API has read routes) is a placeholder page. Packages other than `database`, `shared`,
`ai-provider`, `agent-runtime`, `knowledge`, `memory`, `tools`, `stt`, `tts`, `telephony`, `workflows` and `channels`, and
all three workers, are empty stubs.

Also skipped, small: scanned PDFs (no OCR), a queue for document processing (it runs inside the
API process), a vector index (search is exact), a relevance floor on retrieved passages, renaming
knowledge sources, voice: per-organization Twilio accounts (one platform account from `.env`),
call recording, the employee ending a call itself, transfer to a human, DTMF, voicemail detection on
outbound calls, fixed call lines (greeting aside) in languages other than English, a separate call
worker process (calls run inside the API), a real calendar provider (the calendar is built in), webhook signing, an audit log page (API only), human approval before a tool
runs, availability lookup and cancelling or moving meetings, editing or deleting customer memories (no admin routes yet), relevance ranking of
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

Not installed: Cloudflare R2, a Redis client, Prettier, Turborepo.

