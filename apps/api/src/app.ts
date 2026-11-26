import { clerkPlugin } from "@clerk/fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  embeddingProviderFromEnv,
  providerFromEnv,
  type AIProvider,
  type EmbeddingProvider,
  type Route,
} from "@workforce/ai-provider";
import { resendFromEnv, testEmailSender, whatsappProvidersFromEnv, type EmailProvider, type WhatsAppProvider } from "@workforce/channels";
import { prisma } from "@workforce/database";
import { analyzeWorkspace, finishRun, queueDueEvaluations, runCase, runEvaluation, workspacesWithFailures, type EvaluationDeps } from "@workforce/evaluation-worker";
import { processDocument } from "@workforce/knowledge";
import { memoryService, type MemoryService } from "@workforce/memory";
import { sttFromEnv } from "@workforce/stt";
import { telnyxFromEnv, twilioFromEnv, type TelephonyProvider } from "@workforce/telephony";
import { createToolExecutor, safeFetch, ToolError, toolRegistry, type Mailer } from "@workforce/tools";
import { ttsFromEnv } from "@workforce/tts";
import { HANDOFF_TRIGGER_LABELS, placeCallSchema, type ApiError, type HealthResponse } from "@workforce/shared";
import { createWorkflowEngine, StepError } from "@workforce/workflows";
import Fastify from "fastify";
import { ZodError } from "zod";
import { aiRoutes, credentialsSecretFromEnv, modelRouter, previousSecretFromEnv, type Platform, type ProviderFactory } from "./ai.ts";
import { providerRoutes } from "./providers/routes.ts";
import { providerService } from "./providers/service.ts";
import { clerkAuthenticate, type Authenticate } from "./auth.ts";
import { channelRoutes } from "./channels/routes.ts";
import { channelService, whatsappProviderOf } from "./channels/service.ts";
import { webChatRoutes } from "./channels/webchat.ts";
import { conversationRoutes } from "./conversations.ts";
import { customerRoutes } from "./customers.ts";
import { meterConfigFromEnv, type MeterConfig } from "./billing/meter.ts";
import { billingRoutes } from "./billing/routes.ts";
import { dashboardRoutes } from "./dashboard.ts";
import { billingService } from "./billing/service.ts";
import { stripeClient, stripeFromEnv, type StripeConfig } from "./billing/stripe.ts";
import { employeeRoutes } from "./employees.ts";
import { improvementRoutes } from "./improvements.ts";
import { analyzeInsights, inboxRoutes, quietInsights } from "./inbox.ts";
import type { HandoffNotice, HeldNotice } from "@workforce/agent-runtime";
import { inlineJobs, inngestJobs, type JobDefinitions, type JobEvents, type JobName, type Jobs, type Schedule, type Steps } from "./jobs.ts";
import { knowledgeRoutes } from "./knowledge.ts";
import { developerRoutes } from "./public/manage.ts";
import { publicRoutes } from "./public/routes.ts";
import { webhookService } from "./public/webhooks.ts";
import { reportRoutes } from "./reports.ts";
import { qualityRoutes } from "./quality.ts";
import { toolRoutes } from "./tools.ts";
import { voiceRoutes, type VoiceConfig } from "./voice/routes.ts";
import { workflowRoutes } from "./workflows.ts";
import { workspaceRoutes } from "./workspaces.ts";
import { agentPresence, liveBus, liveRoutes, type LiveBus } from "./live.ts";

/** Advance-then-sleep rounds one workflow/run.due job runs before leaving the rest to the sweep (Inngest caps steps per run). */
const WORKFLOW_ROUNDS = 300;
/** A conversation is evaluated automatically once it has been quiet this long. */
const EVALUATION_IDLE_MS = 10 * 60_000;
/** How often each API process looks for new webhook events and sends due deliveries (without Inngest; with it, every minute). */
const WEBHOOK_TICK_MS = 5_000;

/**
 * `authenticate`, `provider`, `embedder`, `memory`, `toolFetch` and `aiTimeoutMs` exist so tests can supply identities, fake models and a fake network;
 * the server always uses Clerk and the provider configured in .env.
 */
export async function buildApp(
  options: {
    authenticate?: Authenticate;
    provider?: AIProvider;
    embedder?: EmbeddingProvider;
    memory?: (provider: AIProvider, timeoutMs: number) => MemoryService;
    /** The network tools reach; defaults to `safeFetch` (public https only). */
    toolFetch?: typeof fetch;
    /** Telephony, speech and limits; each defaults to what .env configures. */
    voice?: Partial<Omit<VoiceConfig, "providers">>;
    /** The address providers reach the API at, for webhook signatures; defaults to PUBLIC_URL. */
    publicUrl?: string;
    /** Email through Resend, and the sender the send_email tool and Message steps use; default from .env (RESEND_*). */
    email?: { resend: EmailProvider | null; from?: string };
    /** WhatsApp providers; defaults to every one .env has credentials for. */
    whatsapp?: WhatsAppProvider[];
    aiTimeoutMs?: number;
    /** Seals organizations' provider keys (BYOAI); defaults to AI_CREDENTIALS_KEY. null: keys cannot be stored. */
    credentialsKey?: string | null;
    /** Builds providers from organizations' keys; tests pass fakes. */
    byoProvider?: ProviderFactory;
    /** Phase 14: the network adapters built from organizations' connections use (vendors' fixed addresses, and typed addresses); tests pass fakes. */
    providerFetch?: { vendor?: typeof fetch; user?: typeof fetch };
    /**
     * Background jobs: "inngest" or "inline" (in this process), or a factory tests use to capture the job
     * definitions. Defaults to Inngest when INNGEST_EVENT_KEY or INNGEST_DEV is set (never for test apps).
     */
    jobs?: "inngest" | "inline" | ((definitions: JobDefinitions, schedules: Schedule[]) => Jobs);
    /** The live event bus behind GET /workspaces/:workspaceId/events; tests pass one to see what was published. */
    live?: LiveBus;
    /** The workflow runner: how often it looks for due runs, and how often a Voice Call step checks its call. Tests that give this get a runner. */
    workflows?: { intervalMs?: number; callPollMs?: number };
    /**
     * Phase 16: Stripe (default from .env: STRIPE_*; never for test apps), whether plan limits apply (default: when Stripe
     * is configured), and the meter's markup and platform prices (default from .env: BILLING_*).
     */
    billing?: { stripe?: StripeConfig | null; enforced?: boolean; meter?: MeterConfig };
    /** Phase 17: the network webhook deliveries use; defaults to safeFetch (public https only). Tests pass a fake receiver. */
    webhooks?: { fetch?: typeof fetch };
    logger?: boolean;
  } = {},
) {
  // Secrets never reach the log: credentials in bodies, keys in headers (Phase 14).
  const redact = {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["x-api-key"]',
      'req.headers["xi-api-key"]',
      "*.credentials",
      "*.apiKey",
      "*.password",
      "*.secret",
      "*.authToken",
      "*.accessToken",
      "*.encryptedCredentials",
    ],
    censor: "[redacted]",
  };
  // Behind a proxy or load balancer, TRUST_PROXY makes req.ip the caller's address (API key IP allowlists, last use):
  // "true" (trust X-Forwarded-For from anyone in front) or the proxies' addresses/ranges, comma-separated. Unset: the address that connected.
  const trustProxy = process.env.TRUST_PROXY;
  const app = Fastify({
    logger: options.logger === false ? false : { redact },
    trustProxy: !trustProxy ? false : trustProxy === "true" ? true : trustProxy.split(",").map((p) => p.trim()),
  });

  const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
  await app.register(cors, {
    // The web chat widget runs on customers' websites; its routes check the origin against the channel's own list.
    delegator: (req, done) =>
      done(null, { origin: req.url.startsWith("/chat/") ? true : dashboardOrigin, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }),
  });
  await app.register(websocket);

  if (!options.authenticate) {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const secretKey = process.env.CLERK_SECRET_KEY;
    const missing = [
      !publishableKey && "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      !secretKey && "CLERK_SECRET_KEY",
    ].filter(Boolean);
    if (!publishableKey || !secretKey)
      throw new Error(`Missing in .env: ${missing.join(", ")} (see .env.example)`);
    await app.register(clerkPlugin, { publishableKey, secretKey });
  }
  const authenticate = options.authenticate ?? clerkAuthenticate;

  app.setErrorHandler((err: Error & { statusCode?: number; expose?: boolean }, req, reply) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.code(400).send({ error: "Validation failed", issues } satisfies ApiError);
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    // Only errors raised deliberately (httpError, or a 4xx) carry their message to the client.
    const shown = err.expose || status < 500 ? err.message : "Internal server error";
    // Field problems found outside Zod (provider connections checked against the registry) keep their paths.
    const issues = status === 400 ? (err as { issues?: ApiError["issues"] }).issues : undefined;
    return reply.code(status).send({ error: shown, ...(issues && { issues }) } satisfies ApiError);
  });

  app.get("/health", async (_req, reply): Promise<HealthResponse> => {
    const db = await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      (err: unknown) => {
        app.log.error(err, "database health check failed");
        return false;
      },
    );
    if (!db) reply.code(503);
    return { status: db ? "ok" : "degraded", db };
  });

  // Realtime channel for the dashboard. For now it only proves the transport: it echoes.
  app.get("/ws", { websocket: true }, (socket) => {
    socket.on("message", (data) => socket.send(data.toString()));
  });

  // Phase 16: the usage ledger, plan limits and Stripe. Limits apply when billing is on, else nothing is limited.
  const stripeConfig = options.billing ? (options.billing.stripe ?? null) : options.authenticate ? null : stripeFromEnv();
  const stripe = stripeConfig ? stripeClient(stripeConfig) : null;
  const billing = billingService({ ...(options.billing?.meter ?? meterConfigFromEnv()), enforced: options.billing?.enforced ?? stripe !== null }, app.log);
  const planLimits = billing.check;
  billingRoutes(app, authenticate, { billing, stripe, dashboardOrigin });
  dashboardRoutes(app, authenticate, billing);
  reportRoutes(app, authenticate);

  workspaceRoutes(app, authenticate);
  const employeeActions = employeeRoutes(app, authenticate, planLimits);
  customerRoutes(app, authenticate);
  toolRoutes(app, authenticate);

  // Background jobs (jobs.ts). Created last, once everything their handlers use exists; `send` is bound late.
  const durable = !options.authenticate && Boolean(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV);
  const backend = typeof options.jobs === "function" ? "custom" : (options.jobs ?? (durable ? "inngest" : "inline"));
  const jobs: { current?: Jobs } = {};
  const send = <K extends JobName>(name: K, data: JobEvents[K]) => {
    if (!jobs.current) throw new Error("Background jobs are not set up yet");
    return jobs.current.send(name, data);
  };
  /** Whether jobs go to a queue (Inngest) rather than run here; known only once jobs exist, hence a function. */
  const queued = () => jobs.current?.backend === "inngest";

  // Built on first use, so a missing AI key fails a chat request and not the whole server.
  let provider = options.provider;
  let embedder = options.embedder;
  /** The platform's provider: the default for organizations without a model policy, and a target policies may name. */
  const platform: Platform = {
    kind: options.provider?.name ?? (process.env.AI_PROVIDER || "openrouter"),
    get: (model) => options.provider ?? (model ? providerFromEnv({ ...process.env, AI_MODEL: model }) : (provider ??= providerFromEnv())),
  };
  // Email: Resend when RESEND_API_KEY is set; otherwise test mode everywhere (logged, not delivered).
  // Test apps never send real email unless they pass a provider.
  const resend = options.email ? options.email.resend : options.authenticate ? null : resendFromEnv();
  const emailFrom = options.email ? options.email.from : process.env.RESEND_FROM;
  const credentialsKey = options.credentialsKey !== undefined ? options.credentialsKey : credentialsSecretFromEnv();
  // Phase 14: organizations' own provider connections, resolved per request (workflow, employee, default, platform).
  const platformVoice = {
    telephony: [twilioFromEnv(), telnyxFromEnv()].filter((p): p is TelephonyProvider => p !== null),
    stt: sttFromEnv(),
    tts: ttsFromEnv(),
    ...options.voice,
  };
  const whatsapp = options.whatsapp ?? whatsappProvidersFromEnv();
  const providers = providerService({
    secret: credentialsKey,
    previousSecret: previousSecretFromEnv(),
    platform: { stt: platformVoice.stt, tts: platformVoice.tts, telephony: platformVoice.telephony, whatsapp, email: resend, emailFrom: resend ? (emailFrom ?? null) : null },
    fetch: options.providerFetch?.vendor,
    userFetch: options.providerFetch?.user,
    log: app.log,
  });
  // Every model call in the API goes through the router: the tenant's policy, fallback, usage records.
  const router = modelRouter(platform, credentialsKey, app.log, options.byoProvider);
  aiRoutes(app, authenticate, platform, credentialsKey);
  const getEmbedder = () => (embedder ??= embeddingProviderFromEnv());
  const knowledgeActions = knowledgeRoutes(app, authenticate, getEmbedder, (documentId) => send("knowledge/document.uploaded", { documentId }), providers, planLimits);
  /**
   * The send_email tool's, Message steps' and handoff emails' sender: the provider that serves the request's scope, from
   * its From address (RESEND_FROM for the platform's Resend). Test mode when none is configured: nothing is delivered.
   */
  const mailer: Mailer = {
    async send({ to, subject, text, idempotencyKey }, scope) {
      const resolved = scope ? await providers.email(scope) : resend ? { sender: resend, from: emailFrom ?? null, provider: "resend" } : null;
      if (!resolved?.from) return { messageId: idempotencyKey, testMode: true };
      try {
        const { providerMessageId } = await resolved.sender.send({ address: resolved.from, to, subject, text, idempotencyKey });
        return { messageId: providerMessageId, testMode: false };
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : "The email could not be sent");
      }
    },
  };
  const tools = createToolExecutor(toolRegistry, {
    fetch: options.toolFetch,
    mailer,
    onError: (err, tool) => app.log.error({ err, tool }, "Tool failed unexpectedly"),
    planLimits,
  });
  // Live notifications for people in the dashboard (live.ts), and who answers each conversation in the widget.
  const live = options.live ?? liveBus();
  const presence = agentPresence();
  liveRoutes(app, authenticate, live);

  /** Tells the dashboard, emails the escalation contact (test mode without Resend: logged only) and schedules the reminder. */
  const onHandoff = (n: HandoffNotice) => {
    app.log.info({ conversationId: n.conversationId, trigger: n.trigger }, "Conversation handed to people");
    live.publish(n.workspaceId, {
      type: "handoff",
      conversationId: n.conversationId,
      employeeName: n.employeeName,
      reason: `${HANDOFF_TRIGGER_LABELS[n.trigger]}. ${n.reason}`,
      reminder: false,
      waitingMinutes: 0,
    });
    if (n.reminderMinutes > 0)
      send("handoff/reminder.due", {
        handoffId: n.handoffId,
        organizationId: n.organizationId,
        workspaceId: n.workspaceId,
        employeeId: n.employeeId,
        employeeName: n.employeeName,
        conversationId: n.conversationId,
        contactEmail: n.contactEmail,
        minutes: n.reminderMinutes,
        dueAt: new Date(Date.now() + n.reminderMinutes * 60_000).toISOString(),
      }).catch((err: unknown) => app.log.error({ err, conversationId: n.conversationId }, "Handoff reminder could not be scheduled"));
    if (!n.contactEmail) return;
    const email = {
      to: n.contactEmail,
      subject: `${n.employeeName} handed a conversation to your team`,
      text: `${n.employeeName} handed a conversation to your team.

Why: ${HANDOFF_TRIGGER_LABELS[n.trigger]}. ${n.reason}

Open it in the inbox: ${dashboardOrigin}/conversations/${n.conversationId}`,
      idempotencyKey: `handoff:${n.handoffId}`,
    };
    mailer
      .send(email, { organizationId: n.organizationId, workspaceId: n.workspaceId, employeeId: n.employeeId })
      .then(({ testMode }) => testMode && app.log.info({ to: email.to, subject: email.subject }, "Handoff email (test mode, not sent)"))
      .catch((err: unknown) => app.log.error({ err, conversationId: n.conversationId }, "Handoff email failed"));
  };
  const learn = options.memory ?? memoryService;
  const timeoutMs = options.aiTimeoutMs ?? Number(process.env.AI_TIMEOUT_MS || 60_000);
  const ai = {
    provider: (route: Route) => router.provider(route),
    embedder: getEmbedder,
    // Extraction runs on the tenant's "memory" model. With a queue, learning from an exchange is a job
    // (memory/exchange.saved) that loads it by id.
    memory: ({ organizationId, workspaceId }: { organizationId: string; workspaceId: string }): MemoryService => {
      const service = learn(router.provider({ organizationId, workspaceId, task: "memory" }), timeoutMs);
      return {
        ...service,
        remember: async (scope) => {
          if (!queued() || !scope.replyId) return service.remember(scope);
          const { organizationId, workspaceId, customerId, conversationId, replyId } = scope;
          await send("memory/exchange.saved", { organizationId, workspaceId, customerId, conversationId, replyId });
          return [];
        },
      };
    },
    tools,
    timeoutMs,
    onHandoff,
    /** A customer wrote while people have the conversation: tell the dashboard (the assignee gets an alert). */
    onHeld: (n: HeldNotice) =>
      live.publish(n.workspaceId, { type: "customer_message", conversationId: n.conversationId, assignedTo: n.assignedTo, preview: n.message.slice(0, 140) }),
    planLimits,
  };
  conversationRoutes(app, authenticate, ai);
  const voiceConfig: VoiceConfig = {
    publicUrl: process.env.PUBLIC_URL || null,
    // Signs media stream tokens; organizations' own phone accounts need no platform account, so the credentials key will do.
    secret: process.env.TWILIO_AUTH_TOKEN || process.env.TELNYX_API_KEY || credentialsKey,
    limits: { idleMs: 15_000, maxCallMs: 30 * 60_000 },
    ...platformVoice,
    providers,
  };
  const voice = voiceRoutes(app, authenticate, voiceConfig, ai);

  // Messaging channels: WhatsApp, web chat and email, all answered through the same runtime.
  const channels = channelService({
    ai,
    stt: (scope) => providers.stt(scope, "chat"),
    whatsapp: (channel) => {
      const connectionId = (channel.config as { connectionId?: string }).connectionId ?? null;
      const name = whatsappProviderOf(channel);
      const base = (options.publicUrl ?? process.env.PUBLIC_URL)?.replace(/\/+$/, "");
      return providers.whatsapp(name, connectionId, base && connectionId ? `${base}/channels/whatsapp/${name}/c/${connectionId}/webhook` : undefined);
    },
    email: async (scope) => (await providers.email(scope, "chat"))?.sender ?? testEmailSender,
    log: app.log,
    enqueue: (job) => send("channel/message.received", job),
  });
  channelRoutes(app, authenticate, { service: channels, whatsapp, resend, publicUrl: options.publicUrl ?? (process.env.PUBLIC_URL || null), providers });
  providerRoutes(app, authenticate, {
    service: providers,
    secret: credentialsKey,
    platform: { ...providers.platform, llm: platform.kind },
    publicUrl: options.publicUrl ?? (process.env.PUBLIC_URL || null),
  });
  webChatRoutes(app, channels, presence);
  inboxRoutes(app, authenticate, ai, channels, { live, presence });
  qualityRoutes(app, authenticate, send);
  improvementRoutes(app, authenticate, send);
  const evaluation: EvaluationDeps = { provider: ai.provider, embedder: getEmbedder, timeoutMs: ai.timeoutMs };

  const engine = createWorkflowEngine(
    {
    ...ai,
    fetch: options.toolFetch ?? safeFetch,
    async placeCall({ employeeId, to, greeting, idempotencyKey, ...tenant }) {
      const body = placeCallSchema.safeParse({ to, greeting });
      if (!body.success) throw new StepError(`Cannot call "${to}": ${body.error.issues[0]?.message}`);
      try {
        const call = await voice.placeCall({ ...tenant, createdBy: null, idempotencyKey }, employeeId, body.data);
        return { callId: call.id };
      } catch (err) {
        // httpError messages (not configured, not published, provider refused) are meant to be shown.
        const shown = (err as { expose?: boolean }).expose && err instanceof Error;
        throw new StepError(shown ? err.message : "The call could not be placed");
      }
    },
    mailer,
    callPollMs: options.workflows?.callPollMs ?? 15_000,
    onError: (err, context) => app.log.error({ err }, `${context} failed`),
    },
    {
      // With a queue, a run that becomes due is a workflow/run.due job at once.
      onDue: (executionId) =>
        void (queued() && send("workflow/run.due", { executionId }).catch((err: unknown) => app.log.error({ err, executionId }, "Queueing a workflow run failed"))),
    },
  );
  workflowRoutes(app, authenticate, engine, process.env.PUBLIC_URL || null);

  // Phase 17: the public API (/v1, API keys), and what the dashboard manages for it: keys and webhook endpoints.
  publicRoutes(app, { ai, engine, employees: employeeActions, knowledge: knowledgeActions });
  const webhooks = webhookService({ secret: credentialsKey, previousSecret: previousSecretFromEnv(), fetch: options.webhooks?.fetch ?? safeFetch, log: app.log });
  developerRoutes(app, authenticate, { secret: credentialsKey, webhooks });

  const definitions: JobDefinitions = {
    "knowledge/document.uploaded": {
      retries: 0, // processDocument records FAILED itself; reprocessing is a person's choice
      handler: ({ documentId }) =>
        processDocument(
          documentId,
          getEmbedder(),
          (err) => app.log.error({ err, documentId }, "Document processing failed"),
          async (doc) => new Uint8Array(await (await providers.storageById(doc.organizationId, doc.storageConnectionId)).get(doc.storageKey)),
        ),
    },
    "memory/exchange.saved": {
      retries: 1, // each try is a model call
      async handler({ replyId, ...scope }) {
        const reply = await prisma.conversationMessage.findFirst({
          where: { id: replyId, role: "ASSISTANT", conversation: { id: scope.conversationId, organizationId: scope.organizationId, workspaceId: scope.workspaceId } },
        });
        const question =
          reply &&
          (await prisma.conversationMessage.findFirst({
            where: { conversationId: scope.conversationId, role: "USER", createdAt: { lt: reply.createdAt } },
            orderBy: { createdAt: "desc" },
          }));
        if (!reply || !question) return;
        await ai.memory(scope).remember({ ...scope, customerMessage: question.content, reply: reply.content });
      },
    },
    "channel/message.received": {
      orderedBy: "queueKey",
      retries: 1, // only a message still RECEIVED is answered, so a retry after a crash does not answer twice
      handler: ({ messageId }) => channels.answerRecorded(messageId),
    },
    "handoff/reminder.due": {
      retries: 1,
      async handler(r, step) {
        await step.sleepUntil("wait", r.dueAt);
        const waiting = await step.run("check", async () => {
          const handoff = await prisma.handoff.findUnique({ where: { id: r.handoffId }, select: { acceptedAt: true, endedAt: true } });
          return Boolean(handoff && !handoff.acceptedAt && !handoff.endedAt);
        });
        if (!waiting) return;
        live.publish(r.workspaceId, {
          type: "handoff",
          conversationId: r.conversationId,
          employeeName: r.employeeName,
          reason: `Nobody has taken it for ${r.minutes} minutes`,
          reminder: true,
          waitingMinutes: r.minutes,
        });
        if (!r.contactEmail) return;
        await step.run("email", () =>
          mailer.send(
            {
              to: r.contactEmail,
              subject: `Still waiting: a conversation ${r.employeeName} handed to your team`,
              text: `Nobody has taken this conversation for ${r.minutes} minutes.\n\nOpen it in the inbox: ${dashboardOrigin}/conversations/${r.conversationId}`,
              idempotencyKey: `handoff-reminder:${r.handoffId}`,
            },
            { organizationId: r.organizationId, workspaceId: r.workspaceId, employeeId: r.employeeId },
          ),
        );
      },
    },
    "workflow/run.due": {
      retries: 2, // a run is claimed in Postgres, so a retried or duplicate job never runs a step twice
      async handler({ executionId }, step) {
        // Each round advances the run until it waits; a timer wait sleeps in Inngest, not in a process.
        for (let round = 0; round < WORKFLOW_ROUNDS; round++) {
          const next = await step.run(`advance-${round}`, () => engine.runOne(executionId));
          if (!next) return;
          await step.sleepUntil(`wait-${round}`, next);
        }
        // Longer runs (many Voice Call checks) are picked up again by the sweep.
      },
    },
    "evaluation/requested": {
      retries: 0, // the evaluation is claimed (PENDING -> RUNNING) and records its own failure; re-running is a person's choice
      handler: ({ evaluationId }) => runEvaluation(evaluationId, evaluation),
    },
    "evaluation/dataset.run": {
      retries: 0, // replays spend money; cases already graded are skipped if a step runs again
      async handler({ runId }, step) {
        const cases = await step.run("cases", async () => {
          const run = await prisma.evalRun.findUnique({ where: { id: runId }, select: { datasetId: true } });
          if (!run) return [];
          return (await prisma.evalCase.findMany({ where: { datasetId: run.datasetId }, orderBy: { createdAt: "asc" }, select: { id: true } })).map((c) => c.id);
        });
        try {
          for (const caseId of cases) await step.run(`case-${caseId}`, () => runCase(runId, caseId, evaluation));
          await step.run("finish", () => finishRun(runId));
        } catch (err) {
          await prisma.evalRun.update({ where: { id: runId }, data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "The run failed", completedAt: new Date() } });
          throw err;
        }
      },
    },
    "insights/analyze": {
      retries: 1, // no model call; the upsert makes a retry harmless
      // One at a time per workspace, so a sweep of 500 does not take every database connection at once.
      orderedBy: "workspaceId",
      handler: ({ conversationId, ...scope }) => analyzeInsights(scope, [conversationId]),
    },
    "improvement/analyze": {
      retries: 0, // spends model calls; patterns not written are found again by the next analysis
      handler: (scope) =>
        analyzeWorkspace(scope, {
          provider: ai.provider,
          timeoutMs: ai.timeoutMs,
          onError: (err, pattern) => app.log.error({ err, pattern }, "Proposing an improvement failed"),
        }),
    },
  };
  /** Looks for failure patterns in every workspace that had failures lately; the daily improvement-analysis schedule (Inngest only). */
  const analyzeAll = async (step: Pick<Steps, "run">) => {
    const scopes = await step.run("find-workspaces", () => workspacesWithFailures());
    await Promise.all(scopes.map((scope) => send("improvement/analyze", scope)));
    return scopes.length;
  };
  const meterAll = () => billing.meter(null, new Date(Date.now() - 3 * 86_400_000));
  /** Queues evaluations of conversations that went quiet; the evaluation-sweep schedule, or a timer without Inngest. */
  const sweepEvaluations = async (step: Pick<Steps, "run">) => {
    const ids = await step.run("queue-evaluations", () => queueDueEvaluations({ idleMs: EVALUATION_IDLE_MS }));
    await Promise.all(ids.map((evaluationId) => send("evaluation/requested", { evaluationId })));
    return ids.length;
  };
  /** Queues insights/analyze for conversations that went quiet with a missing or stale insight; the insights-sweep schedule, or a timer without Inngest. */
  const sweepInsights = async (step: Pick<Steps, "run">) => {
    const rows = await step.run("find-conversations", () => quietInsights({ idleMs: EVALUATION_IDLE_MS }));
    await Promise.all(rows.map((row) => send("insights/analyze", row)));
    return rows.length;
  };
  const schedules: Schedule[] = [
    {
      id: "workflow-sweep",
      cron: "* * * * *",
      // Catches what no event announced: a lost send, a paused workflow resumed, a runner that died mid-step.
      async handler(step) {
        const ids = await step.run("find-due-runs", () => engine.dueRuns(100));
        await Promise.all(ids.map((executionId) => send("workflow/run.due", { executionId })));
        return ids.length;
      },
    },
    { id: "evaluation-sweep", cron: "*/5 * * * *", handler: sweepEvaluations },
    { id: "insights-sweep", cron: "*/5 * * * *", handler: sweepInsights },
    { id: "improvement-analysis", cron: "0 6 * * *", handler: analyzeAll },
    // The usage meter over every organization: catches what no limit check or billing page metered (3 days back, idempotent).
    { id: "usage-meter", cron: "*/5 * * * *", handler: (step) => step.run("meter", () => meterAll()) },
    // Webhooks with Inngest: new events and due deliveries every minute (up to 20 rounds of 25), instead of each process's timer.
    { id: "webhook-sweep", cron: "* * * * *", handler: (step) => step.run("webhooks", () => webhooks.tick(null, 20)) },
  ];
  jobs.current =
    typeof options.jobs === "function"
      ? options.jobs(definitions, schedules)
      : backend === "inngest"
        ? inngestJobs(app, definitions, schedules)
        : inlineJobs(definitions, app.log);

  // Without a queue, workflows run on the in-process runner (see DECISIONS.md). Tests run it only when
  // they ask for it, so test files running side by side never run each other's workflows.
  const runner = !queued() && (!options.authenticate || options.workflows !== undefined);
  const stopRunner = runner ? engine.startRunner(options.workflows?.intervalMs ?? 1000) : async () => {};
  // Likewise the evaluation sweep: every 5 minutes in process, as Inngest's schedule would. Never in test apps:
  // they share the database with development (tests call queueDueEvaluations for their own organization).
  const sweeping = !queued() && !options.authenticate;
  let sweep: Promise<unknown> = Promise.resolve();
  const timer = sweeping
    ? setInterval(() => {
        sweep = sweep
          .then(() => sweepEvaluations({ run: (_id, fn) => fn() }))
          .catch((err: unknown) => app.log.error({ err }, "Evaluation sweep failed"))
          .then(() => sweepInsights({ run: (_id, fn) => fn() }))
          .catch((err: unknown) => app.log.error({ err }, "Insights sweep failed"))
          .then(meterAll)
          .catch((err: unknown) => app.log.error({ err }, "Usage meter failed"));
      }, 5 * 60_000)
    : undefined;

  // Webhooks without Inngest: every API process scans for events and sends due deliveries; both are claimed or deduplicated
  // in Postgres, so processes never send an event twice. Never in test apps (tests run their own service for their organization).
  let webhookRound: Promise<unknown> = Promise.resolve();
  const webhookTimer = options.authenticate || queued()
    ? undefined
    : setInterval(() => {
        webhookRound = webhookRound.then(() => webhooks.tick()).catch((err: unknown) => app.log.error({ err }, "Webhook round failed"));
      }, WEBHOOK_TICK_MS);

  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(webhookTimer);
    await webhookRound;
    await sweep;
    await stopRunner();
    await prisma.$disconnect();
  });
  return app;
}
