// BYOAI and model routing for the API: an organization's provider keys (sealed at rest, never returned), its
// model policy per task, the router every model call goes through, and usage reports.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  AIProviderError,
  createProvider,
  createRouter,
  maxOutputTokensFromEnv,
  modelInfo,
  type AIProvider,
  type Route,
  type RoutePlan,
  type RouteTarget,
  type UsageRecord,
} from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import {
  AI_TASKS,
  credentialSchema,
  credentialUpdateSchema,
  modelPolicySchema,
  type AiCredential,
  type AiPolicy,
  type AiProviderKind,
  type AiSettings,
  type AiTask,
  type AiUsageSummary,
  type ModelInfo,
  type ModelTarget,
} from "@workforce/shared";
import { isPrivateAddress, safeFetch } from "@workforce/tools";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";

// ---- Keys at rest ----

/** AES-256-GCM under a key derived from AI_CREDENTIALS_KEY. The format names its version so the scheme can change. */
export function sealKey(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function openKey(sealed: string, secret: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unknown sealed key format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

const keyFrom = (secret: string) => createHash("sha256").update(secret).digest();

/** The secret must be long enough to be random (e.g. `openssl rand -base64 32`). */
export const credentialsSecretFromEnv = () => {
  const secret = process.env.AI_CREDENTIALS_KEY ?? "";
  return secret.length >= 32 ? secret : null;
};

// ---- Routing ----

/** The platform's own provider (from .env, or the test's fake), optionally with another model. */
export type Platform = { kind: string; get: (model?: string) => AIProvider };
/** Builds a provider from an organization's credential; `createProvider`, or a fake in tests. */
export type ProviderFactory = typeof createProvider;

type CredentialRow = Prisma.AiCredentialGetPayload<object>;

/**
 * Builds the routing plan for a request from the organization's policy for the task (or its default policy).
 * No policy: the platform's provider alone, as before Phase 13.
 */
// shortcut: one or two indexed queries per model call; cache plans per organization for a few seconds if call volume needs it
export async function planFor(route: Route, platform: Platform, secret: string | null, create: ProviderFactory = createProvider): Promise<RoutePlan> {
  const policies = await prisma.aiModelPolicy.findMany({ where: { organizationId: route.organizationId, task: { in: [route.task, "default"] } } });
  const policy = policies.find((p) => p.task === route.task) ?? policies.find((p) => p.task === "default");
  if (!policy) return { targets: [{ provider: platform.get(), kind: platform.kind, credentialId: null }], maxCostUsd: null, timeoutMs: null, allowedProviders: [], strategy: "ordered" };

  const wanted = [policy.primary, ...(policy.fallbacks as ModelTarget[])] as ModelTarget[];
  const ids = [...new Set(wanted.map((t) => t.credentialId).filter((id): id is string => id !== null))];
  const credentials = ids.length > 0 ? await prisma.aiCredential.findMany({ where: { organizationId: route.organizationId, id: { in: ids } } }) : [];
  const maxOutputTokens = maxOutputTokensFromEnv();
  const targets: RouteTarget[] = [];
  for (const target of wanted) {
    if (target.credentialId === null) {
      targets.push({ provider: platform.get(target.model), kind: platform.kind, credentialId: null, info: modelInfo(platform.kind, target.model) });
      continue;
    }
    // A credential deleted after the policy was saved is skipped; deleting one a policy uses is refused anyway.
    const credential = credentials.find((c) => c.id === target.credentialId);
    if (!credential) continue;
    if (!secret) throw new AIProviderError("config", "AI_CREDENTIALS_KEY is not set on the server, so the organization's keys cannot be read");
    targets.push(byoTarget(credential, target.model, secret, maxOutputTokens, create));
  }
  return {
    targets,
    maxCostUsd: policy.maxCostUsd,
    timeoutMs: policy.timeoutMs,
    allowedProviders: policy.allowedProviders,
    strategy: policy.strategy as RoutePlan["strategy"],
  };
}

const byoTarget = (credential: CredentialRow, model: string, secret: string, maxOutputTokens: number, create: ProviderFactory): RouteTarget => {
  const custom = credential.kind === "openai_compatible";
  const openSealed = (c: CredentialRow) => {
    try {
      return openKey(c.secret, secret);
    } catch (err) {
      throw new AIProviderError("config", `The key "${c.name}" cannot be read: AI_CREDENTIALS_KEY changed since it was saved. Enter the key again.`, err);
    }
  };
  return {
    provider: create(credential.kind, {
      model,
      maxOutputTokens,
      apiKey: openSealed(credential),
      ...(custom && credential.baseUrl && { baseUrl: credential.baseUrl.replace(/\/+$/, ""), fetch: safeFetch }),
    }),
    kind: credential.kind,
    credentialId: credential.id,
    info: modelInfo(credential.kind, model, credential.models as ModelInfo[]),
  };
};

/** The router the whole API uses. `ai.provider(route)` hands out providers bound to a route. */
export function modelRouter(platform: Platform, secret: string | null, log: FastifyBaseLogger, create?: ProviderFactory) {
  const record = ({ route, ...usage }: UsageRecord) => {
    prisma.aiUsage
      .create({ data: { organizationId: route.organizationId, workspaceId: route.workspaceId ?? null, task: route.task, ...usage } })
      // An organization that does not exist (yet) or a database hiccup loses a usage row, never the reply.
      .catch((err: unknown) => log.warn({ err, route }, "Recording AI usage failed"));
  };
  return createRouter({ plan: (route) => planFor(route, platform, secret, create), record });
}

// ---- Routes ----

const taskParams = z.object({ task: z.enum(AI_TASKS) });
const idParams = z.object({ id: z.string().min(1) });
const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const toCredential = (c: CredentialRow): AiCredential => ({
  id: c.id,
  name: c.name,
  kind: c.kind as AiProviderKind,
  baseUrl: c.baseUrl,
  keyHint: c.keyHint,
  models: c.models as ModelInfo[],
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const toPolicy = (p: Prisma.AiModelPolicyGetPayload<object>): AiPolicy => ({
  task: p.task as AiTask,
  primary: p.primary as ModelTarget,
  fallbacks: p.fallbacks as ModelTarget[],
  maxCostUsd: p.maxCostUsd,
  timeoutMs: p.timeoutMs,
  allowedProviders: p.allowedProviders as AiProviderKind[],
  strategy: p.strategy as AiPolicy["strategy"],
  updatedAt: p.updatedAt.toISOString(),
});

const hintOf = (key: string) => `…${key.slice(-4)}`;

/** A custom base URL must lead to a public address: the server makes the request, so it must not reach the private network. */
async function assertPublicBaseUrl(baseUrl: string | null) {
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (url.username || url.password) throw httpError(400, "The base URL must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw httpError(400, `${url.hostname} could not be found`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw httpError(400, `${url.hostname} is a private address`);
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";

export function aiRoutes(app: FastifyInstance, authenticate: Authenticate, platform: Platform, secret: string | null) {
  const { member, admin } = guards(authenticate);
  const needSecret = () => {
    if (!secret) throw httpError(503, "AI_CREDENTIALS_KEY is not set on the server (32+ random characters), so keys cannot be stored");
    return secret;
  };

  app.get("/ai/settings", async (req): Promise<AiSettings> => {
    const { organizationId } = member(req);
    const [credentials, policies] = await Promise.all([
      prisma.aiCredential.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } }),
      prisma.aiModelPolicy.findMany({ where: { organizationId } }),
    ]);
    let model = "(not configured)";
    try {
      model = platform.get().model;
    } catch {
      // The platform provider is misconfigured; the settings still load.
    }
    return {
      platform: { provider: platform.kind, model },
      credentials: credentials.map(toCredential),
      policies: policies.map(toPolicy).sort((a, b) => AI_TASKS.indexOf(a.task) - AI_TASKS.indexOf(b.task)),
      canStoreKeys: secret !== null,
    };
  });

  app.post("/ai/credentials", async (req, reply): Promise<AiCredential> => {
    const auth = admin(req);
    const key = needSecret();
    const body = credentialSchema.parse(req.body);
    await assertPublicBaseUrl(body.baseUrl);
    try {
      const row = await prisma.aiCredential.create({
        data: {
          organizationId: auth.organizationId,
          name: body.name,
          kind: body.kind,
          baseUrl: body.baseUrl,
          secret: sealKey(body.apiKey, key),
          keyHint: hintOf(body.apiKey),
          models: body.models,
          createdBy: auth.userId,
        },
      });
      reply.code(201);
      return toCredential(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw httpError(409, `A key named "${body.name}" already exists`);
      throw err;
    }
  });

  app.put("/ai/credentials/:id", async (req): Promise<AiCredential> => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const body = credentialUpdateSchema.parse(req.body);
    const existing = await prisma.aiCredential.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!existing) throw httpError(404, "Key not found");
    if (body.kind !== existing.kind) throw httpError(400, "The provider of a key cannot change; add a new key instead");
    await assertPublicBaseUrl(body.baseUrl);
    try {
      const row = await prisma.aiCredential.update({
        where: { id },
        data: {
          name: body.name,
          baseUrl: body.baseUrl,
          models: body.models,
          ...(body.apiKey && { secret: sealKey(body.apiKey, needSecret()), keyHint: hintOf(body.apiKey) }),
        },
      });
      return toCredential(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw httpError(409, `A key named "${body.name}" already exists`);
      throw err;
    }
  });

  app.delete("/ai/credentials/:id", async (req, reply) => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const existing = await prisma.aiCredential.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!existing) throw httpError(404, "Key not found");
    const policies = await prisma.aiModelPolicy.findMany({ where: { organizationId: auth.organizationId } });
    const users = policies.filter((p) => [p.primary, ...(p.fallbacks as ModelTarget[])].some((t) => (t as ModelTarget).credentialId === id)).map((p) => p.task);
    if (users.length > 0) throw httpError(409, `Used by the ${users.join(", ")} model policy. Change those policies first.`);
    await prisma.aiCredential.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.put("/ai/policies/:task", async (req): Promise<AiPolicy> => {
    const auth = admin(req);
    const { task } = taskParams.parse(req.params);
    const body = modelPolicySchema.parse(req.body);
    const targets = [body.primary, ...body.fallbacks];
    const ids = [...new Set(targets.map((t) => t.credentialId).filter((v): v is string => v !== null))];
    const owned = await prisma.aiCredential.findMany({ where: { organizationId: auth.organizationId, id: { in: ids } }, select: { id: true } });
    // Another organization's credential id is as unknown as a made-up one.
    if (owned.length !== ids.length) throw httpError(400, "A model refers to a key this organization does not have");
    const data = { ...body, primary: body.primary, fallbacks: body.fallbacks, updatedBy: auth.userId };
    const row = await prisma.aiModelPolicy.upsert({
      where: { organizationId_task: { organizationId: auth.organizationId, task } },
      create: { organizationId: auth.organizationId, task, ...data },
      update: data,
    });
    return toPolicy(row);
  });

  app.delete("/ai/policies/:task", async (req, reply) => {
    const auth = admin(req);
    const { task } = taskParams.parse(req.params);
    await prisma.aiModelPolicy.deleteMany({ where: { organizationId: auth.organizationId, task } });
    return reply.code(204).send();
  });

  app.get("/ai/usage", async (req): Promise<AiUsageSummary> => {
    const { organizationId } = member(req);
    const { days } = usageQuery.parse(req.query);
    const where = { organizationId, createdAt: { gte: new Date(Date.now() - days * 86_400_000) } };
    const sums = { _sum: { inputTokens: true, outputTokens: true, costUsd: true }, _avg: { latencyMs: true }, _count: { _all: true } } as const;
    const [byModel, failedByModel, byTask, fallbacks, recent] = await Promise.all([
      prisma.aiUsage.groupBy({ by: ["provider", "model"], where, ...sums }),
      prisma.aiUsage.groupBy({ by: ["provider", "model"], where: { ...where, success: false }, _count: { _all: true } }),
      prisma.aiUsage.groupBy({ by: ["task"], where, _sum: { costUsd: true }, _count: { _all: true } }),
      prisma.aiUsage.count({ where: { ...where, attempt: { gt: 1 } } }),
      prisma.aiUsage.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
    ]);
    const groups = byModel
      .map((g) => ({
        provider: g.provider,
        model: g.model,
        calls: g._count._all,
        failures: failedByModel.find((f) => f.provider === g.provider && f.model === g.model)?._count._all ?? 0,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        costUsd: g._sum.costUsd ?? 0,
        avgLatencyMs: Math.round(g._avg.latencyMs ?? 0),
      }))
      .sort((a, b) => b.calls - a.calls);
    const calls = groups.reduce((n, g) => n + g.calls, 0);
    return {
      days,
      totals: {
        calls,
        failures: groups.reduce((n, g) => n + g.failures, 0),
        fallbacks,
        inputTokens: groups.reduce((n, g) => n + g.inputTokens, 0),
        outputTokens: groups.reduce((n, g) => n + g.outputTokens, 0),
        costUsd: groups.reduce((n, g) => n + g.costUsd, 0),
        avgLatencyMs: calls === 0 ? 0 : Math.round(groups.reduce((n, g) => n + g.avgLatencyMs * g.calls, 0) / calls),
      },
      byModel: groups,
      byTask: byTask.map((t) => ({ task: t.task, calls: t._count._all, costUsd: t._sum.costUsd ?? 0 })).sort((a, b) => b.calls - a.calls),
      recent: recent.map((r) => ({
        id: r.id,
        task: r.task,
        requestId: r.requestId,
        attempt: r.attempt,
        provider: r.provider,
        model: r.model,
        credentialId: r.credentialId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        success: r.success,
        errorKind: r.errorKind,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
