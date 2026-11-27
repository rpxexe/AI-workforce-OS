# Decisions and traps

Why things are the way they are. Add an entry when a choice would otherwise be re-argued or a
problem re-discovered.

## Decisions

- **Versioning is append-only.** Saving an employee inserts a new `AiEmployeeVersion`; nothing
  updates a version. "Live" is a pointer (`publishedVersionId`) moved only by Publish. Rollback is
  publishing an older version. This is how "do not overwrite production configuration" is met.
- **Status is separate from versions.** DRAFT means never published. The status endpoint accepts
  ACTIVE, PAUSED, ARCHIVED; restoring an unpublished employee returns it to DRAFT.
- **Roles: members read, `org:admin` writes.** Our reading of "basic roles"; uses Clerk's built-in
  roles, no custom permissions. Change in `guards()` if members should edit.
- **Clerk is the source of truth for users, organizations, members, roles.** No user table and no
  webhooks. The UI shows "You" or "A teammate" for authors.
- **Workspaces partition an organization.** Employees carry both `organizationId` and
  `workspaceId`; routes are nested under `/workspaces/:workspaceId`.
- **Avatars are icon keys**, not uploads, because file storage (R2) is not wired yet.
- **No `tsx`.** The API runs on Node's native TypeScript support. Hence `erasableSyntaxOnly` and
  `.ts` import extensions in the root tsconfig.
- **Version pins.** TypeScript 6.0 (typescript-eslint does not support 7 yet). Prisma 7.10
  (npm "latest" was an 8.0 release candidate). ESLint 9 (eslint-config-next plugins).
- **Root tsconfig covers API, packages and workers**; the dashboard has its own. Stub packages
  need only `package.json` and `src/index.ts`.
- **Zod schemas live in `@workforce/shared`** so the form and the API validate identically.
- **Loading skeletons use `skullet` (pinned 0.0.3)**, the owner's choice and the one exception to "shadcn only".
  Each page wraps its real content in `<Skullet data sample>` (imported as `Skeleton as Skullet` from
  `skullet/react`) with a typed module-level `SAMPLE`, so the skeleton has the page's shape. Content
  that fetches or mutates by id renders only for real data (`data === SAMPLE ? null : …`). Colours and
  the flex/gap pass-through for its wrapper divs are in `globals.css`. `LoadingState` remains a
  generic fallback.
- **OpenRouter is the default AI provider** (owner's choice), default model `openrouter/auto`, which
  lets OpenRouter choose per request; pin one with `AI_MODEL`. It is called with `fetch`, no SDK.
  Anthropic remains selectable with `AI_PROVIDER=anthropic` (default `claude-opus-5-5`); nothing
  outside `packages/ai-provider/src/anthropic.ts` imports its SDK.
- **The runtime writes to the database itself**, not through a storage interface, so every channel
  gets persistence by calling `runTurn`. The API route holds no conversation logic.
- **A failed turn saves nothing.** The user message and the reply are inserted together after the
  reply completes, so stored conversations contain only complete exchanges and a retry cannot
  duplicate a message. The chat page puts the unsent text back in the box.
- **Test chat talks to the latest version**, published or not, and only admins can send (it spends
  money and writes data); members can read conversations. Archived employees cannot be tested.
- **Knowledge is attached to the employee, not to a version.** Attaching or detaching a source
  takes effect on the next message, for every version. Versions stay immutable.
- **Embeddings are 1536 dimensions**, from `openai/text-embedding-3-small` through OpenRouter. The
  column is `vector(1536)`; a model with another size needs a migration and reprocessing every
  document. Searches only compare vectors made by the current `EMBEDDING_MODEL`.
- **Uploaded files are stored in Postgres** (`KnowledgeDocument.content`) so they can be
  reprocessed; object storage (R2) is not wired. Uploads are capped at 10 MB.
- **Uploads are a raw request body**, not multipart: one file per request, name in the query
  string. It avoids a multipart dependency.
- **Documents are processed by a background job** (`knowledge/document.uploaded`). With Inngest, a restart no longer
  strands a document; without it (in process) a restart mid-processing still leaves it PENDING until reprocessed.
- **No vector index.** Search is exact, filtered by tenant first. A hand-written HNSW index would
  be dropped by the next `prisma migrate dev`, because Prisma does not know about it.
- **Retrieved passages go in the system prompt**, and the question is sent as the user wrote it,
  so stored conversations and later turns contain the real question.
- **If retrieval fails, the turn fails.** An employee with knowledge attached does not fall back
  to answering without it.
- **Refusal fallbacks are not enabled** on the Anthropic call: the parameter is a beta that some
  models reject, and `AI_MODEL` is free-form. A refusal is reported as an error instead.

- **Customers belong to a workspace**, not to an employee: every employee in the workspace shares
  what is known about a customer. The same email in two workspaces is two customers.
- **Memory is key/value facts, not embedded message snippets.** The model proposes facts; a
  deterministic validator (`parseExtraction`) decides what is stored. One value per key, so
  "budget" is updated rather than accumulated. No vector search: a customer has tens of facts.
- **Extraction runs after the reply, in the background**, so memory adds no latency to the reply.
  The cost is a second model call per turn with a customer, on the same `AI_PROVIDER` and model.
- **A conversation's customer is fixed when it starts.** Test chat sends `customer` only for new
  conversations.
- **Secrets are rejected by code, not only by prompt**: keys like password/otp/cvv and Luhn-valid
  13 to 19 digit numbers never reach the database.

- **Tools are granted to the employee, not to a version**, like knowledge: a grant takes effect on
  the next message. The executor re-reads the grant on every call, so revoking stops the next call
  even mid-turn.
- **A grant covers the permissions the tool had when granted.** If a tool later declares a new
  permission, existing grants are denied until an admin grants it again.
- **Tool settings belong to the admin, arguments to the model.** The webhook URL and HTTP host list
  are grant config; the model cannot name another destination.
- **Retries are opt-in per tool and never after a timeout**, because the first try may have acted.
  Calendar and email do not retry; GET requests and webhooks (idempotency key = execution id) do.
- **Tool side effects survive a failed turn.** If the reply fails after a meeting was booked, the
  meeting and its audit row stay, the conversation is not saved. The conversation id is generated
  before the first tool call so audit rows and events can point at it.
- **Calls in one model response run one at a time, in order**, since they may depend on each other.
- **The calendar is built in; email goes through Resend** (owner's choice, 2026-11-19), test mode without a key.
  The booking tool converts local time with the employee's working-hours time zone.
- **The current date and time are in the system prompt** (employee's time zone), so "tomorrow at
  3 PM" can be resolved. This changes the prompt every minute; it already varied with knowledge.
- **Anthropic tools use `eager_input_streaming`** (the SDK skill's default for streamed client
  tools); the executor validates every input, which that requires.

- **Deepgram for STT, ElevenLabs for TTS** (owner's choice), Twilio for telephony. All three are
  called directly (fetch, `ws`), no SDKs. Twilio's audio, Deepgram's input and ElevenLabs' output are
  all 8 kHz mu-law, so audio is never converted.
- **TTS is one HTTP request per sentence**, started as soon as the sentence is complete, so the next
  sentence is synthesized while the current one plays. ElevenLabs' WebSocket input buffers text and
  its docs say it may not be faster when sentences are known.
- **Calls run inside the API process** on the WebSocket the API already serves, not in
  `workers/call-worker`; a separate worker would need its own public URL. Move them when calls need
  to survive API restarts or scale apart.
- **Media streams are authenticated with a signed `<Parameter>` token** checked on the `start`
  message, because Twilio does not sign the WebSocket handshake and stream URLs cannot carry a query
  string. Webhooks are checked with `X-Twilio-Signature` against `PUBLIC_URL` + path.
- **Barge-in triggers on interim words, not on voice activity**, so coughs and line noise do not cut
  the employee off.
- **The greeting is a template** (`{name}`) on the phone number or the outbound call, because the
  runtime only answers a caller's turn; the model speaks from the caller's first words on.
- **Callers are identified as customers by their phone number**, so memory carries across calls and
  across chat for the same identifier.
- **Telnyx is used through TeXML**, its Twilio-compatible markup, so webhooks, form fields and call
  statuses are Twilio's and only the media message format differs. Call Control (JSON events) would
  have needed a second call flow. Providers come from `.env` for now; a provider settings page is planned.
- **Telnyx webhooks carry a secret token in their URL** (`?token=`, an HMAC of the API key), because
  Telnyx does not document signing TeXML's voice URL request. Its Ed25519 headers are not checked yet.
- **Telnyx's outbound call API returns no call id** (per its API reference), so outbound status callback
  URLs carry `?callId=`, and the first callback stores the provider's id on the call.
- **API errors raised with `httpError` show their message even when 5xx** (502 from Twilio, 503 when
  not configured). Before, every 5xx said "Internal server error", hiding the provider-config 503.

- **Workflow runs are Postgres rows claimed with `FOR UPDATE SKIP LOCKED`**, not Redis/BullMQ or Inngest: no new
  infrastructure, runs survive restarts, waits are a `runAt` column, and several API processes can share the work.
  The runner lives in the API process (`buildApp`), like calls and document processing; move `startRunner` into
  `workers/agent-worker` when runs should scale apart. Tests get a runner only when they pass `workflows`, so test
  files running side by side never run each other's workflows.
- **The workflow definition is our own JSON**, not React Flow's node format. React Flow only draws it
  (`workflow-canvas.tsx`) and `onChange` hands back a new definition; positions are stored, the engine ignores them.
- **Workflows follow the employee versioning model**: saving appends a `WorkflowVersion`, publishing moves the live
  pointer, a run keeps the version it started with. Name and description are not versioned.
- **No loops, one way out per node** (yes and no for conditions). Runs stay finite and the engine is a simple walk.
- **Voice Call steps poll the Call row** instead of hooking into the call session: no change to voice code, and a
  lost status callback cannot strand a run (the step fails after 45 minutes).
- **Tool steps go through `ToolExecutor` with an employee's grant**, so workflows get the same permissions,
  validation and audit log as conversations; there are no workflow-level tool settings.
- **Retry is manual**: a failed step may have half-acted, so a person decides. Tools keep their own retry policy.
- **Idempotency keys are per step attempt** (`execution:node:attempt`): a crash re-run continues the same attempt and
  finds or deduplicates its effect; a manual retry is a person asking for the effect again, so it gets a new key.
  Where an effect cannot be found again (an AI Employee turn that may have used tools, a call row with no provider
  id), the step fails rather than risk doing it twice.
- **Deleting a workflow is a soft delete**: run history and audit rows stay, and restore is possible. It refuses
  while runs are in progress unless the caller says to stop them (the dashboard asks, naming the runs and the
  webhook). Restored workflows come back paused.
- **Inngest schedules workflow runs; Postgres still owns them** (2026-11-19). Run state, step rows, idempotency keys,
  `claim` and `advance` stay; Inngest replaces only the polling loop: an event per due run, `step.sleepUntil` for
  waits, a one-minute sweep for anything no event announced. Claiming in Postgres means a duplicate, late or retried
  event cannot run a step twice. Human Handoff does not use `waitForEvent`: Continue sends a new run event, which keeps
  one code path for both backends. A job runs at most 300 advance/sleep rounds; longer runs go back to the sweep.
- **Background jobs: Inngest, with an in-process fallback** (owner asked for Inngest). One set of handlers
  (`jobs.ts`); Inngest when its keys or `INNGEST_DEV` are set, else in process as before, so tests and keyless
  development need nothing running. Inngest brings retries, per-customer ordering across API processes (concurrency
  key, replacing the in-process queue), and sleeps that survive restarts.
- **Job events carry ids, never customer text**: Inngest stores event payloads, and conversations stay in our
  database. Memory jobs load the exchange by the reply id; channel jobs read the message's stored payload.
- **The example books the lead's requested time** (`preferredDate`, `preferredTime` in the trigger data). The call
  decides interest; picking a time during the call would need the employee to book it then (it can, with the
  calendar tool) or an extraction step.
- **React Flow 12.12.1, pinned exactly**: 13.0 was a day old when Phase 8 was built.

- **WhatsApp behind a provider interface: Meta, Twilio and Telnyx** (owner's choice, 2026-11-19), like telephony:
  any of them configured at once, each number on one, so a future provider settings page can switch them. Each
  provider turns its own webhook into the common model; the pipeline never sees provider formats. Called with `fetch`,
  no SDKs. One account per provider from `.env` for now. Meta channels route by Phone number ID, Twilio and Telnyx by
  the number itself; settings saved before providers existed count as Meta.
- **One customer key across channels, not an identity table.** Phones are stored as `+digits` everywhere (callers,
  WhatsApp's `wa_id` with "+" added, website identities normalized), emails in lower case. Phone and email of the same
  person stay two customers; merging needs an identity table and a merge rule (later).
- **Web chat visitors are matched to known customers only when the website signs the identity** (HMAC with the
  channel secret). An unsigned phone number from a browser could be anyone's, and would expose what the employee
  remembers about that person. Anonymous visitors get their own customer and memory.
- **Chat conversations continue for 24 hours of silence** (WhatsApp's own service window), then a new conversation
  starts, with the old one's summary recalled. Email continues by thread (In-Reply-To our message id) however long.
- **Webhooks answer 200 first and work after**, deduplicated by the provider's message id in the audit table (unique
  index), because Meta retries slow or failed webhooks. A customer's messages are answered one at a time, in order.
- **The inbound row settles after the reply is handed to the channel**, so RECEIVED means "still working" and a
  crash leaves visible RECEIVED rows rather than a false ANSWERED.
- **Sends are retried only on explicit rate-limit answers**, never on timeouts or network errors, since Meta and
  Twilio have no idempotency key and a retry after an unknown outcome could send a message twice. Telnyx takes an
  `Idempotency-Key`, so its sends also retry after network errors and 5xx.
- **Files the model cannot see are described to it** ("the customer sent an image with the caption ..."), voice notes are
  transcribed with the same Deepgram account, documents use the knowledge parser. Only metadata is stored.
- **Channel tool limits are enforced twice**: not offered to the model, and refused by the executor (`allowedTools` on
  the scope), so a model naming an unoffered tool cannot run it. The same check now makes "only tools offered this
  turn are run" true everywhere.
- **The widget is plain JavaScript served by the API** (`/widget.js`), in a shadow root, no build step, no
  framework, so any website can embed it and the host page's CSS cannot break it. Replies are plain text
  (`textContent`): no markdown rendering, so no HTML injection.
- **Email through Resend** (owner's choice): one provider sends for the email channel, the `send_email` tool and
  workflow Message steps, and receives mail on a verified domain. Called with `fetch`, no SDK. Without
  `RESEND_API_KEY` everything stays in test mode, as before. The JSON inbound hook stays for other inbound services.
- **Email threads by a tagged Reply-To** (`support+<conversation id>@domain`), because Resend assigns the Message-ID
  of what we send and does not tell us, so a customer's In-Reply-To cannot be matched to our reply. Resend receives
  every address on the domain, and the tag only continues a conversation that belongs to the same customer.
- **Test apps never use the `.env` email key**: a test that does not pass a provider gets test mode, so a developer's
  real Resend key cannot send mail from the test suite.
- **Voice turns go to the channel message log too**, so one log answers "what did customers say and what did they get
  back" on every channel; the timed call transcript stays as it was.

- **Handoff state lives on the conversation and is enforced in `runTurn`** (Phase 10), not in each channel, so no
  channel can forget it. While people have a conversation the customer's message is still saved (`held`), so the
  agent and, later, the AI see it.
- **Human agents are organization members, not only admins.** Answering customers is the agent's job; admins still own
  configuration. Change in `inbox.ts` if agents should be admins only.
- **Deterministic triggers run in code, judgement calls go to the model.** An explicit request for a person, a
  high-value customer and configured conditions are checked before the model is called (no cost, testable); low
  confidence and policy risk are reported by the model through a `transfer_to_human` tool that is not in the tool
  registry (it acts on the conversation, not the world). High-value and condition triggers fire once per conversation,
  so an agent handing it back to the AI is respected.
- **The handoff message is saved as the employee's reply**, so every channel delivers it the way it delivers any reply.
- **An agent's message is delivered before it is stored**, so the conversation never shows a message the customer did
  not get; a failed send is a 502 and the agent can retry.
- **Copilot suggestions are their own table**, never conversation messages; the agent's message records which suggestion
  it came from and whether it was edited.
- **Polling, not push**, for the inbox (5 s), an open conversation and test chat (4 s) and the widget while people have
  the chat (4 s): the `/ws` socket is still an echo, and polling needs no new infrastructure.
- **Live call transfer replaces the call's markup with `<Dial>`** through the providers' update-call API, to one
  transfer number per employee (`escalation.transferNumber`: a person or a team line), not per agent: agents have no
  phone numbers in our data, and a team line lets the phone system ring whoever is free. If no one answers, the call
  ends and the conversation stays in the inbox queue for a callback. The result comes from `<Dial action>` (answered
  and talk time, no answer, busy, cancelled), and every attempt has a `CallTransfer` row created before the provider
  is asked. A failed transfer does not return the caller to the AI: the conversation is with people, and the AI must
  stay silent until someone hands it back.
- **Escalation settings added later are filled with defaults when read** (`configOf`), so old versions stay immutable
  and still load in the form.

- **Evaluation observes, never steers** (Phase 11). Grades live in their own tables, the runtime reads none of them, and
  jobs grade after the fact. Acting on them (alerts, routing, prompt changes) is a later decision.
- **Evaluators follow the versioning model, with one difference**: saving appends a version, but it becomes current at
  once (no separate publish), because a grader changes no customer-facing behaviour. Every result names the version that
  produced it, so changing a rubric never rewrites history.
- **Three grader kinds**: deterministic checks for what the data already knows (tool outcomes, handoff timestamps, reply
  latency), phrase rules for policy (cheap, explainable, testable), and LLM graders with a rubric for judgement
  (correctness, grounding, tone, resolution). Policy rules are phrase lists, not regular expressions: admins' patterns run
  on the server, and an escaped phrase list cannot be a slow regex.
- **Automatic evaluation waits for a quiet conversation** (10 minutes, swept every 5), not every turn: one grading per
  conversation state, and a duplicate state is refused by a unique key. The cost is LLM grader calls (four per
  conversation with the defaults), so LLM evaluators can be turned off one by one.
- **The evaluation worker is a package run as API jobs** (`workers/evaluation-worker`, through `jobs.ts` on Inngest or in
  process), like every other background job. A separate process would need its own deployment; move it when grading
  should scale apart from the API.
- **Links are resolved when the evaluation is created**: the employee version and model of the last reply, and the
  workflow version from data workflows already write (an AI Employee step's output, a Voice Call step's call idempotency
  key). No new column on conversations.
- **Regression replays go through `runTurn`** on a conversation with the `evaluation` channel, with the chosen version,
  so knowledge retrieval, prompts and handoff logic are the production ones. They get no tools (a replay must not book or
  send anything), no customer memory and no handoff notifications; the channel keeps them out of the inbox, analytics and
  the sweep.
- **Test apps never run the evaluation sweep**: tests share the database with development, and a global sweep would
  queue evaluations of the developer's own conversations. Tests call `queueDueEvaluations` with their organization.

- **Improvement never edits an employee by itself** (Phase 12). The analysis job writes suggestions only. A version is created
  when an admin asks to test a suggestion, it is not published, and it can be neither published nor rolled out until an admin
  approves it after the regression runs finished. Promote, roll back and publish are admin requests. This answers "never
  silently modify production" while keeping versions append-only: a suggestion's version is an ordinary version with a link.
- **The model may change only instructions, personality and goals.** Channels, tools, knowledge and escalation decide what the
  employee can do and who is told; a grader's verdict is not enough reason to change them. Proposals outside those fields are
  dropped by code (`parseProposal`), and the merged configuration must pass the same schema the form uses.
- **A pattern is an evaluator failing on the live version** (3+ failures, 20%+ of its results, 14 days), one suggestion per
  version and evaluator, ever: a rejected suggestion is not proposed again for that version, and a new version starts fresh.
- **The regression suite is a Phase 11 dataset linked to the employee**, not a new kind of thing: admins see and edit it on the
  dataset page, and testing a suggestion adds the conversations that failed (with "do not repeat" expectations) and a few
  recent passing ones (so a fix that breaks what worked shows as "broken"). Both versions are replayed on the same cases at
  the same time, so a model's day-to-day variation affects both.
- **Rollouts are per customer, by hash, not per message**: sha256(rollout id + customer key) mod 100 against the share, so a
  customer keeps one version across messages and channels, and raising the share never moves anyone back. No assignment
  table. One candidate per rollout and one rollout per employee (a unique column set only while active).
- **Publishing is blocked during a rollout**: the control is the published version, so moving it mid-test would mix the
  comparison. Promote or roll back first.
- **The KPI is read from evaluations** (Phase 11) by the employee version of each conversation's last reply: average score,
  share passing, or one dimension's pass rate. The control side also counts 14 days before the rollout, so a 5% rollout still
  has a baseline; the verdict waits for 10 conversations per side and a difference beyond a 95% Welch test. People promote or
  roll back; nothing acts on the verdict automatically.
- **Rollback publishes the version that was live before the current one**, from a release log that every publish, promote and
  rollback writes (`EmployeeRelease`). Rollbacks are skipped when looking back, so two rollbacks go back two versions instead
  of flipping between two.
- **The daily analysis runs on Inngest only**; without it, "Find improvements" runs it. A second in-process timer was not
  worth it for a once-a-day job.

- **The router is an `AIProvider`** (Phase 13): `ai.provider(route)` returns a provider bound to a tenant and a task, so every
  caller kept its code and only names its task. Who answered travels on the `done` event (`provider`, `model`, `costUsd`); the
  router's own name is never stored.
- **Policies are per organization, not per workspace or employee.** The organization holds the keys and the bill; a task-level
  policy (chat, voice, memory, ...) covers the task type and latency needs (voice can be pointed at a fast model).
- **No policy = the platform provider, and the platform is never added silently as a fallback.** An organization that brought
  its own key may not want its data sent elsewhere, nor the platform to pay; it lists the platform as a fallback if it wants one.
- **Fallback only before the first text, once per model, at most 3 models.** Text already streamed cannot be taken back
  (a second model would repeat or contradict it), and a bounded list of concrete providers (never a router) cannot loop.
  Refusals are not shopped around; a caller that cancelled is not retried. A tool step is a new call, so it is routed again.
- **A cost limit skips models with no known price.** An unknown price cannot be checked; the error lists every model ruled out
  and why. OpenRouter's reported cost is recorded after the fact but cannot be known before the call.
- **Keys are sealed with one server secret** (`AI_CREDENTIALS_KEY`), not a KMS: no new infrastructure. Rotating it meant
  re-entering keys; since Phase 14, `AI_CREDENTIALS_KEY_PREVIOUS` opens old rows while they are sealed again. Without it, keys cannot be stored and everything runs on the platform.
- **Usage rows are written per attempt and not awaited**, so a failed write never fails a reply; a row lost to a database hiccup
  is logged.
- **Latency and cooldown are remembered in the process**, not in the database: they steer ordering only, and a restart just
  measures again.

- **One connection table for every provider type** (Phase 14). Phase 13's `AiCredential` became `ProviderConnection` rows of type
  `llm` with the same ids (the migration copies them; the sealed key moves unchanged as format `v1`), so policies, usage rows and
  `/ai/credentials` keep working. New rows seal a JSON object of all secret fields (`v2`); a `v1` row is sealed again as `v2` the
  first time it is opened.
- **The catalog is data in `@workforce/shared`, the registry is code in `@workforce/providers`.** The dashboard renders forms and
  validates with the same catalog and `checkFields` the API uses; adapters and test calls stay on the server. "Supported" means a
  catalog entry with a registry entry (a test enforces it); everything else is `coming_soon` and cannot be connected.
- **Coming soon: Plivo, Vonage, SIP, and live recognition on Google and Azure** (owner's choice). Plivo and Vonage stream audio in
  their own formats (Vonage: 16 kHz linear PCM over its own protocol), SIP needs a media server, Google's live API is gRPC and
  Azure's is its SDK. Google and Azure transcribe recorded voice notes. VoiceStudio is supported through its OpenAI-compatible
  `/v1/audio/speech` (owner's request): it runs on the owner's machine, so it must be exposed at a public https address.
- **Audio from OpenAI-compatible speech servers is asked for as WAV and converted** (`wavToMulaw`: header parsed as it streams,
  mono, box-filtered resample to 8 kHz, G.711 mu-law). WAV says its own rate and depth, which "pcm" from unknown servers (Kokoro,
  VoiceStudio, custom) does not.
- **Resolution: workflow > employee > organization default > platform; later levels are fallbacks, the platform only when chosen**
  (an override naming it, or nothing configured at all), as Phase 13 decided for models. Overrides live on the employee and the
  workflow, not on versions, like tools and knowledge. A disabled or deleted connection named by an override is skipped (disabling
  is how an admin stops its use). For language models the task policy sits between the overrides and the default connection.
- **No fallback on authentication or configuration errors**, for every type including Phase 13's router: a wrong key or setting is
  the admin's to fix, and routing around it would hide it and send data to a provider nobody picked for that request.
- **What does not fall back**: telephony and WhatsApp (a number belongs to one account), storage (a file must be read where it was
  written), email after anything but a "try later" refusal (a network error or 5xx may have sent it).
- **Telephony and WhatsApp per organization through connection paths** (`/voice/<provider>/c/<id>/...`), not a lookup by number
  first: the signature can only be checked once the account is known, and a number only answers on its own connection.
  Stream tokens are signed with a platform secret (`AI_CREDENTIALS_KEY` when no platform phone account exists).
- **Calls check for live speech before ringing**: an inbound call is turned away politely, an outbound call refused (503), when the
  employee resolves to no provider with the `live` capability (Whisper alone can transcribe voice notes but not answer calls).
- **Test Connection uses the cheapest call that proves the key** and is limited to 10 per organization per minute; a second press
  while a test runs shares its answer. Limits live in the process (several API processes each keep their own).
- **DNS rebinding is closed by pinning, not by a second check**: `safeFetch` passes an undici `Agent` whose `lookup` refuses private
  answers, so the address checked is the address connected to. SMTP connects to the checked IP and verifies TLS against the name.
- **Uploads go to the organization's default storage when it has one**, else Postgres as before. A document remembers the
  connection it was written to, so changing the default never loses files, and a connection holding files cannot be deleted.
- **Speech, email and call usage share `AiUsage`** (with `providerType`, `operation`, `characters`, `seconds`) rather than new
  tables: one place for metrics, one pattern for "one row per attempt". Costs for them are estimated only when the admin enters
  `costPerUnit` on the connection: vendor prices change and no built-in table would stay right.
- **Memory confidence is the extractor's own rating**, stored when it gives one between 0 and 1 and ignored otherwise; a person's
  edit sets it to 1. Nothing acts on it yet (recall sends every fact); it is shown so admins can spot shaky facts.
- **Clearing a customer's memory also blanks conversation summaries**, because summaries are recalled into prompts just like facts.
  Conversations and messages stay: they are the business's record, not memory. Audit rows name keys and counts, never values, so a
  delete does not leave the deleted value behind in the log.
- **OmniDimension is a delegated telephony provider, not a media stream.** It runs its own speech, model and voice and offers no
  raw call audio, so our employee cannot talk on its calls. The owner wanted it as a calling provider anyway: employees (and
  workflow Voice Call steps) dispatch calls to an OmniDimension agent, and the transcript and summary come back into the
  conversation and customer memory. The employee's instructions, knowledge and tools do not apply during those calls; the
  agent's own prompt in OmniDimension does.

- **Conversation intelligence is deterministic and computed on read** (Phase 15). Phrase lists and regular expressions in
  English, Hindi and Hinglish: free, instant, testable, and each label can point at the phrase that produced it. Nothing is
  stored, so there is no backfill and no migration; the overview reads the newest 2,000 conversations of a period. Store
  insights per conversation (or add a model) when workspaces outgrow that or the misses matter.
- **Locale is operational context, not a classification of the customer.** Indian conventions (₹, lakh, day-first dates, +91 for
  bare 10-digit numbers) apply when the business's employee runs in an Indian time zone or an Indian language variant. A
  customer's +91 number, Hindi or name never changes how they are treated; the prompt tells the model not to infer background
  from them. Analytics count languages of messages, not nationalities.
- **Follow the customer's language and script per message.** Hinglish answered in Roman letters, Hindi in Devanagari: the
  latest message decides, so a customer who switches is followed. The employee's language stays the default.
- **Hinglish is an employee language (`hi-en`), mapped per speech provider**, so STT/TTS stay provider-agnostic: providers that
  can listen for several languages do (Deepgram `multi`), the rest are told Hindi or left to detect.
- **Aadhaar and PAN are recognised only to be masked or refused**: entities show `XXXX XXXX 1234`, memory rejects values and keys
  that hold them. `pin_code` stays a secret key (it may be a card PIN); postal codes are stored as `postal_code`.
- **Hindi call lines avoid gendered first-person verbs** (passive forms), since the employee's gender is not known.

- **The usage ledger is derived from rows that already record each fact** (Phase 16), not written at each call site. AiUsage,
  messages, calls, tool executions and workflow runs are immutable records the code already writes in one place each; the meter
  copies them with set-based SQL. Ledger ids are `<sourceType>:<sourceId>` with ON CONFLICT DO NOTHING, so any number of meter
  runs, retries or API processes count each fact once, and every billed line names its source. New code paths that write those
  rows are billed without touching billing.
- **Charges come from the ledger, never from counters**: a period's usage charge is the sum of the ledger's `amountUsd` over the
  period, written once as a `UsageCharge` before Stripe is called, and sent with an idempotency key.
- **Markup applies to platform cost only** (owner's choice; the rate is set only in the server's environment, never in the repository). Organizations' own keys are paid to the vendor directly,
  so their usage is recorded with amount 0. A cost nobody knows is recorded as unpriced and not billed, never guessed.
- **Calls are billed per started minute from the Call row**, once the duration settled (10 minutes after the call ended), because
  the provider's billed length can replace our estimate right after hang-up and ledger rows are never updated.
- **Stripe is isolated in one file and holds money, not truth.** Plans, limits, usage and invoices' copies live in our tables; Stripe
  objects are re-read on every subscription event (order-proof), and the only Stripe features used are Checkout, subscriptions,
  invoice items and the portal, so another gateway is a rewrite of `billing/stripe.ts` and the webhook route.
- **Usage is one invoice line per period, added to the renewal draft** rather than Stripe meters or Metronome (Stripe's recommendation
  for new usage billing): our ledger already has the numbers, and the owner wants to be able to change payment gateway, which
  Metronome would make harder. Revisit for prepaid credits or enterprise contracts.
- **Stripe review (stripe-best-practices skill, 2026-11-24)**: API version pinned (`2026-11-18.endive`); Checkout sends
  `integration_identifier` and never `payment_method_types`; organizations are resolved through the stored Stripe customer first,
  metadata and `client_reference_id` only as fallbacks; refunds, disputes and early fraud warnings are logged with the organization
  (nothing automatic acts on them); restricted keys (`rk_`) and sandboxes recommended in `.env.example`. Still fetch, not Stripe's
  SDK (the codebase calls every vendor that way).
- **The markup and the platform's provider cost are never shown to tenants** (owner's company policy, 2026-11-24). Billing, Reports,
  Model routing > Usage and Settings > provider metrics show what is billed, and provider cost only for an organization's own keys
  (its own vendor bill). The markup lives in `BILLING_MARKUP` on the server; `billing.test.ts` asserts no response carries it.
- **Limits are enforced only when billing is on** (Stripe configured), so development, tests and self-hosted servers are not limited.
  A limit check that fails (database hiccup) allows the action: the usage is still recorded and billed.
- **Limits stop new work, not work in progress**: a refused turn saves nothing and says why; a call over the minutes limit finishes;
  memory, Copilot and graders are not refused (they are billed).

- **The public API has its own contract, written by hand** (Phase 17). `public-api.ts` holds zod schemas of every object customers see,
  the route table and the webhook payloads; the API maps rows into them in one file (`public/serialize.ts`) and parses every answer
  with its schema, so an internal field can never leak and an internal rename cannot change a response. The OpenAPI document and the
  SDK's types come from the same objects, and TypeScript requires a handler for every route in the table. Internal routes keep their
  own types and may change freely. Versioned as `/v1`: within it, only additions.
- **API keys belong to one workspace and carry scopes**, like the dashboard's tenant model: the key's row decides the organization and
  workspace, never the request. A key is `wfk_<prefix>_<secret>`; only a SHA-256 hash is stored. The secret has 256 random bits, so a
  fast unsalted hash is safe (a slow hash protects guessable passwords, not random keys) and keeps verification cheap. Last use is
  written at most once a minute per key. Revoked keys stay as records.
- **Rotation creates a new key and gives the old one a grace period** (0, 1, 24 or 168 hours), so a deployment can switch without
  downtime; 0 revokes it at once.
- **Webhook events are derived from rows, like the usage ledger**, not emitted at each call site: messages, conversations, workflow
  runs, handoffs and calls are already written in one place each, and a scan every 5 seconds turns new ones into deliveries with
  deterministic ids, unique per endpoint. No code path can forget to emit, a crash between a write and an emit cannot lose an event,
  and any number of API processes can scan. Cost: up to ~5 seconds of latency (a minute on Inngest).
- **A scan cursor per endpoint, not a fixed window** (Phase 17, second pass): each scan reads from `scannedAt` minus 10 minutes (rows
  whose transaction committed after their timestamp), never more than 7 days back, and moves the cursor only after a scan that was not
  cut off by its 500-row page. An API that was down catches up; the NOT EXISTS check keeps the overlap from sending anything twice.
- **Webhook delivery: a 5-second timer in each API process without Inngest, Inngest's `webhook-sweep` schedule (every minute) with it.**
  Deliveries are rows claimed with `SKIP LOCKED` either way, so the schedule only replaces the timer (as for workflows): serverless
  deployments get delivery without a long-lived process, and the database is queried once a minute instead of every 5 seconds.
- **Standard Webhooks signing** (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<HMAC-SHA256>`): a published scheme that
  receivers' libraries already verify (Svix's included), with replay protection from the timestamp. The signing secret is sealed under
  `AI_CREDENTIALS_KEY` (it must be read to sign), shown once, and the endpoint must be public https (checked on save and on every send).
- **Retries: 8 attempts over about 3 days** (1 min, 5 min, 30 min, 2 h, 5 h, 10 h, 24 h), any non-2xx or no answer in 10 s; redirects
  are not followed. `webhook-id` stays the same on every attempt and on redelivery, so receivers deduplicate on it.
- **Idempotency-Key on the two public writes** (send a message, start a run): the first answer is stored and replayed for 24 hours per
  workspace; a failed request stores nothing, so it can be retried. The SDK adds a key itself when it retries a write.
- **Two message routes: whole and streamed.** `/messages` answers with the whole reply (and takes an Idempotency-Key); `/messages/stream`
  sends server-sent events through the same turn, refusing everything it can before the stream opens. Streams are not retried by the SDK:
  a turn that started may have used tools.
- **API writes go through the dashboard routes' own functions** (`employeeRoutes` and `knowledgeRoutes` return `create`, `saveVersion`,
  `publish`, `uploadDocument`; `resolveConversation` in inbox.ts), acting as `api:<key id>`, so plan limits, versioning, rollout checks,
  release logs and storage behave the same. The public employee shape is smaller than the internal config (name, role, description,
  personality, instructions, goals, language, timeZone); everything else starts from the dashboard's defaults and is kept on new versions.
- **Per-key rate limits count in each API process** (a fixed one-minute window), like Test Connection's limit: no new infrastructure,
  exact on one process, up to N times the limit on N processes. IP allowlists check `req.ip`, so deployments behind a proxy set
  `TRUST_PROXY`.
- **Webhook secret rotation signs with both secrets during a grace period** (Standard Webhooks allows several space-separated
  signatures), so receivers switch without losing a request; the SDKs accept any matching signature.
- **The SDK's types are generated, not imported**: `packages/sdk/generate.ts` turns the contract's zod schemas into plain TypeScript
  (`src/types.ts`, checked in, a test fails when stale), so the published package has no dependency on the monorepo or zod. Built with
  `tsc` (`rewriteRelativeImportExtensions`), no bundler. Python uses the standard library only; both SDKs mirror one route table.
- **Publishing the SDKs is the owner's step**: the package names must be in npm and PyPI accounts the owner controls, so `private: true`
  stays until a name is chosen.

- **Conversation insights are stored, not computed on every read** (`ConversationInsight`, one row per conversation). The insights
  read recomputes rows that are missing or older than the conversation's `updatedAt` (newest first, at most 500 per request; the rest
  catch up on the next reads), then counts stored rows in SQL, so there is no 2,000-conversation cap. Lazy on read keeps one code path
  and needs no job: `updatedAt` already moves with every message, status change and handoff. Not-yet-refreshed rows still count with
  their older values, dated by `activityAt`.
- **Insights are computed by a job when a conversation goes quiet** (2026-11-26), swept like grading (`insights-sweep`, 10 minutes
  idle, every 5 minutes; `insights/analyze` per conversation, ids only). The lazy read path stays as the safety net for a delayed
  job or a still-active conversation, so the output is unchanged; normally it finds nothing to do.
- **Messages carry their conversation's tenant** (`ConversationMessage.organizationId`/`workspaceId`, copied on every insert,
  backfilled by migration `20261126130000_message_tenant`, index `(organizationId, workspaceId, createdAt, conversationId)`), so
  "active conversations" (handoff rate and its previous period, in handoff analytics and the dashboard; `activeConversations` in
  inbox.ts) are counted from the workspace's messages of the period instead of a relation filter that probes every conversation of
  the workspace. Distinct conversation ids come from the index alone, then each conversation is joined once for the channel. A
  message-driven query on the existing `createdAt` index was not enough: the planner still walked the workspace's conversations, or
  read every tenant's messages of the period. EXPLAIN ANALYZE, 6M synthetic messages, 600k conversations, 40 workspaces: 240k-
  conversation workspace, 30 days 1.7-3.7 s before (1.9-2.3 s / 0.75-1.6 s with `createdAt` only), 0.27 s after; previous 30 days
  1.5 s to 0.27 s; 15k-conversation workspace 0.22-0.28 s to 0.02 s. Conversations never move workspace, so the copy cannot drift.
- **Handoff analytics and the quality overview aggregate in SQL** instead of loading 10,000 rows: `percentile_disc` equals the
  nearest-rank `stats()`, averages and one-decimal means are rounded in JS from SQL sums and counts, and ties keep the most recent
  group first (`max(...) DESC`), as the in-memory version did.

## Traps already hit

- **`tsx watch` does not start under `pnpm --parallel` on Windows.** Fixed by using `node --watch`.
- **`pnpm add` inside a package crashes when the path has a lower-case drive letter** (`d:\`), which
  is what Git Bash and this VS Code workspace give. Use `--filter` from the root, or PowerShell at `D:\`.
- **Prisma 7 `migrate dev` does not regenerate the client.** The `migrate` script runs `generate` after.
- **Clerk 7 has no implicit keyless mode.** Without both keys the dashboard returns 500 and the API
  refuses to start, naming the missing variable.
- **Clerk middleware needs `signInUrl` passed explicitly**, or signed-out users go to Clerk's hosted
  page. `createRouteMatcher` is deprecated; `proxy.ts` checks the pathname itself.
- **Signed-out non-browser requests get 404 from Clerk, not a redirect.** Test with
  `Accept: text/html` and `Sec-Fetch-Dest: document`.
- **Next.js 16 keeps visited pages mounted but hidden.** Form state survives navigation, so forms
  reset `saving` in `finally` and are re-keyed after a successful save.
- **Next.js reports "dropped segment" if a layout withholds `children`.** The shell always renders
  the page; `withWorkspace` shows the loading state inside the page instead.
- **shadcn's `SidebarMenuSkeleton` uses `Math.random()`** and causes a hydration mismatch. Use `Skeleton`.
- **shadcn's generated `use-mobile.ts` failed lint**; rewritten with `useSyncExternalStore`.
- **`@fastify/cors` allows only GET, HEAD, POST by default.** Methods are listed explicitly.
- **Prisma `upsert` is not atomic**: it reads, then inserts, so simultaneous calls fail with P2002.
  First-request provisioning in `GET /workspaces` returned 500s on real Postgres because of it.
  Use `createMany({ skipDuplicates: true })` (`ON CONFLICT DO NOTHING`) for create-if-missing.
- **A `prisma dev` throwaway database cannot take the two API test files in parallel.** Test
  against the Docker Postgres instead.
- **The Anthropic SDK reports a missing API key as a plain `AnthropicError`**, not an `APIError`, and
  only when the first request is made. `anthropic.ts` maps that to the `auth` kind.
- **Prisma `migrate dev --create-only` then edit** is how the pgvector migration got its
  `CREATE EXTENSION IF NOT EXISTS vector` line; Prisma does not write it.
- **Do not type `\uFEFF` in a regex through an editor that expands escapes**: it became a literal
  invisible character and failed lint. `parse.ts` compares the char code instead.
- **Node's `BlockList` checks IPv4 addresses against IPv6 rules too** (as `::ffff:a.b.c.d`), so a
  `::ffff:0:0/96` rule blocks every IPv4 address. It also maps the other way by itself; no rule needed.
- **Bidirectional Twilio streams never echo our audio**: only the caller's track arrives, so there is
  no echo to cancel, and `mark` echoes are the only signal that audio was heard.
- **Test fakes that serve both the reply and memory extraction get their scripts consumed by the
  background extraction call.** Fake providers answer requests whose system prompt starts with
  `EXTRACTION_PROMPT` separately.
- **The secret-file hook blocks any command that names `.env`**, including
  `node --env-file=../../.env`. Run tests with `pnpm test` (`LIVE_AI=1 pnpm test` for live ones).
- **React Flow controlled nodes stay hidden until measured.** The canvas keeps the `dimensions` changes from
  `onNodesChange` and passes them back as `measured`; dropping them leaves nodes invisible.
- **Next.js keeps the list page mounted while a detail page shows**, so a headless-browser check waiting for
  `tbody tr` can match the hidden list. Wait for something only the visible page has.
- **A dev dependency named `cn`** is legitimate: shadcn publishes it and its registry requires it.

- **A webhook test that checks the inbound row raced the reply**: the row said ANSWERED before the outbound row
  existed. Fixed by settling the inbound row last (see Decisions).
- **`satisfies` an interface rejects an object's extra methods.** WhatsApp providers are typed as returning the
  `WhatsAppProvider` interface, which has every method they expose.
- **Long heredocs through the Bash tool can fail to parse** ("unexpected EOF while looking for matching `'`"). Write
  edit scripts with the file tool and run them.
- **The secret-file hook also blocks running one test file** with `node --env-file=../../.env --test <file>`; run
  the whole suite with `pnpm test`.

- **Heredocs through the Bash tool still fail** when the text has quotes or backticks (hit again in Phase 10). Write
  the script with the file tool, then run it.

- **`prisma migrate dev` refuses to run non-interactively when it would warn** (here: a new unique column). Write the SQL
  with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` into a new migration folder,
  then `prisma migrate deploy` (Phase 12).
- **`schema.prisma` has CRLF line endings**; edit scripts that match multi-line text must normalise them first.
- **Importing `@workforce/providers` (or `@workforce/tools`) loads `@workforce/database`**, which throws without `DATABASE_URL`;
  tests that need no database set a dummy one before importing (Phase 14).
- **Prisma `groupBy` with a shared `by` variable does not typecheck**; the provider metrics use one SQL query with `FILTER` instead.
- **ESLint's `no-misleading-character-class` rejects a Devanagari class range starting at U+0900** (a combining sign); ranges in
  `entities.ts` start at U+0904. Python edit scripts must use raw strings for regexes: `"\b"` became a backspace once (Phase 15).
- **A Fastify `httpError` drops custom fields**; the error handler now passes `issues` through on 400s so catalog field checks map
  to form fields like Zod's do.

- **A running `pnpm dev` raced the webhook tests** (Phase 17): its 5-second timer claimed the test organizations' deliveries in the shared
  database and sent them to the test's unreachable address. The server's timer now skips organizations whose id starts with
  `org_test_` (testing.ts `newOrg`; Clerk ids never have a second underscore); tests deliver their own with `tick(organizationId)`.
- **Prisma's `$queryRaw` tag reads cooked template strings**: `\_` in a LIKE pattern became a bare `_` wildcard. Use
  `starts_with()` for prefixes.
- **Tailwind runs through `postcss.config.mjs` (`@tailwindcss/postcss`), not a custom Turbopack CSS loader.** The old
  `turbopack.rules` loader (`@tailwindcss/turbopack`) left stale CSS in `.next/cache`. Production builds, including Vercel's,
  which restores that cache, shipped the pre-redesign `globals.css`: wrong font variable, old colors and radius.

## Checking the signed-in UI without a login

Real sign-in needs a person. To exercise the UI automatically, temporarily alias `@clerk/nextjs`
and `@clerk/nextjs/server` to stubs via `turbopack.resolveAlias`, run the API through
`buildApp({ authenticate })` with a fixed identity, and drive headless Edge over the DevTools
protocol. Remove all of it afterwards; none of it is in the repo.

## Unbounded lists page by keyset cursor; counts come from their own request

Every list that can grow without bound (customers, workflows, knowledge sources, archived employees, webhook
deliveries) pages by keyset (apps/api/src/cursor.ts): the cursor holds the last row's sort value and id and a
fingerprint of tenant, search and filters, and the next page asks for rows after that pair. OFFSET repeated and
skipped rows whenever the list changed between clicks (customers move whenever they talk), and grew slower with depth;
keyset reads only the page (customers: 0.2 ms at row 10,000 of 300k, against 9 ms with OFFSET). It does not freeze
the list: a row whose sort value changes moves to its new place. Cursors are not signed: every query also filters on
the caller's tenant, and a cursor used with another search or filter is a 400.

Pages never count. Tiles and "of N" come from a separate counts/summary request per search (customers/counts,
workflows/summary, knowledge/sources/summary), so changing page costs one indexed range read. The delivery log has no
count at all. The footer (useCursorPaged, rules in lib/cursor-pages.ts with tests) has first, previous and next but
no last page, since a page's cursor comes from the one before; Next is off while a page loads.

Transcripts (inbox conversation, test chat) load the newest 100 messages; older ones load by cursor when the reader
scrolls to the top (LoadOnView sentinel, scroll position kept), and polls ask only for messages after the newest one
shown (`?after=`), following `more` until caught up, so a burst of any size between polls is never skipped. Keyset
polling can in principle miss a message whose insert commits after a newer one was read; each message is one short
insert, so the window is milliseconds.

Bounded lists load whole and page in the browser with `usePaged`: current employees (50 per plan), an employee's
attached knowledge (20 at most). Migrations that build or drop indexes on big tables use `CREATE/DROP INDEX
CONCURRENTLY` alone in their file (it cannot run in a transaction).
