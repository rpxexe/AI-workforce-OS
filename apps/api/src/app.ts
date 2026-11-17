import { clerkPlugin } from "@clerk/fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  embeddingProviderFromEnv,
  providerFromEnv,
  type AIProvider,
  type EmbeddingProvider,
} from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { memoryService, type MemoryService } from "@workforce/memory";
import { sttFromEnv } from "@workforce/stt";
import { twilioFromEnv } from "@workforce/telephony";
import { createToolExecutor, toolRegistry } from "@workforce/tools";
import { ttsFromEnv } from "@workforce/tts";
import type { ApiError, HealthResponse } from "@workforce/shared";
import Fastify from "fastify";
import { ZodError } from "zod";
import { clerkAuthenticate, type Authenticate } from "./auth.ts";
import { conversationRoutes } from "./conversations.ts";
import { customerRoutes } from "./customers.ts";
import { employeeRoutes } from "./employees.ts";
import { knowledgeRoutes } from "./knowledge.ts";
import { toolRoutes } from "./tools.ts";
import { voiceRoutes, type VoiceConfig } from "./voice/routes.ts";
import { workspaceRoutes } from "./workspaces.ts";

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
    voice?: Partial<VoiceConfig>;
    aiTimeoutMs?: number;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, {
    origin: process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
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
    return reply.code(status).send({ error: shown } satisfies ApiError);
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

  workspaceRoutes(app, authenticate);
  employeeRoutes(app, authenticate);
  customerRoutes(app, authenticate);
  toolRoutes(app, authenticate);

  // Built on first use, so a missing AI key fails a chat request and not the whole server.
  let provider = options.provider;
  let embedder = options.embedder;
  const getEmbedder = () => (embedder ??= embeddingProviderFromEnv());
  knowledgeRoutes(app, authenticate, getEmbedder);
  const tools = createToolExecutor(toolRegistry, {
    fetch: options.toolFetch,
    onError: (err, tool) => app.log.error({ err, tool }, "Tool failed unexpectedly"),
  });
  const ai = {
    provider: () => (provider ??= providerFromEnv()),
    embedder: getEmbedder,
    memory: options.memory ?? memoryService,
    tools,
    timeoutMs: options.aiTimeoutMs ?? Number(process.env.AI_TIMEOUT_MS || 60_000),
  };
  conversationRoutes(app, authenticate, ai);
  voiceRoutes(
    app,
    authenticate,
    {
      telephony: twilioFromEnv(),
      stt: sttFromEnv(),
      tts: ttsFromEnv(),
      publicUrl: process.env.PUBLIC_URL || null,
      secret: process.env.TWILIO_AUTH_TOKEN || null,
      limits: { idleMs: 15_000, maxCallMs: 30 * 60_000 },
      ...options.voice,
    },
    ai,
  );

  app.addHook("onClose", () => prisma.$disconnect());
  return app;
}
