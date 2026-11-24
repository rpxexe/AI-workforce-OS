// BYOAI and model routing for the API: an organization's provider keys (sealed at rest, never returned), its
// model policy per task, the router every model call goes through, and usage reports.
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
import { hintOf, openCredentials, scrubSecrets, sealCredentials } from "@workforce/providers";
import {
  AI_TASKS,
  credentialSchema,
  credentialUpdateSchema,
  modelPolicySchema,
  providerOverridesSchema,
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

// ---- Keys at rest (Phase 14: @workforce/providers seals every connection) ----

export { openKey, sealKey } from "@workforce/providers";

/** The secret must be long enough to be random (e.g. `openssl rand -base64 32`). */
export const credentialsSecretFromEnv = () => {
  const secret = process.env.AI_CREDENTIALS_KEY ?? "";
  return secret.length >= 32 ? secret : null;
};

/** While rotating AI_CREDENTIALS_KEY: the old one, so connections sealed with it still open (and are sealed again). */
export const previousSecretFromEnv = () => process.env.AI_CREDENTIALS_KEY_PREVIOUS || null;

// ---- Routing ----

/** The platform's own provider (from .env, or the test's fake), optionally with another model. */
export type Platform = { kind: string; get: (model?: string) => AIProvider };
/** Builds a provider from an organization's credential; `createProvider`, or a fake in tests. */
export type ProviderFactory = typeof createProvider;

type ConnectionRow = Prisma.ProviderConnectionGetPayload<object>;

/** The LLM targets an employee's or workflow's overrides name for a route: workflow first (Phase 14). */
async function overrideTargets(route: Route): Promise<ModelTarget[]> {
  const [workflow, employee] = await Promise.all([
    route.workflowId ? prisma.workflow.findFirst({ where: { id: route.workflowId, organizationId: route.organizationId }, select: { providerOverrides: true } }) : null,
    route.employeeId ? prisma.aiEmployee.findFirst({ where: { id: route.employeeId, organizationId: route.organizationId }, select: { providerOverrides: true } }) : null,
  ]);
  const targets: ModelTarget[] = [];
  for (const row of [workflow, employee]) {
    const llm = row ? providerOverridesSchema.safeParse(row.providerOverrides).data?.llm : undefined;
    if (llm) targets.push({ credentialId: llm.connectionId, model: llm.model });
  }
  return targets;
}

/**
 * Builds the routing plan for a request. Resolution (Phase 14): the workflow's and the employee's own model first, then
 * the organization's policy for the task (or its default policy), else its default language-model connection, else the
 * platform's provider alone, as before Phase 13. Levels after the first are the fallbacks; the platform is never added
 * silently.
 */
// shortcut: a few indexed queries per model call; cache plans per organization for a few seconds if call volume needs it
export async function planFor(route: Route, platform: Platform, secret: string | null, create: ProviderFactory = createProvider): Promise<RoutePlan> {
  const [policies, overrides] = await Promise.all([
    prisma.aiModelPolicy.findMany({ where: { organizationId: route.organizationId, task: { in: [route.task, "default"] } } }),
    overrideTargets(route),
  ]);
  const policy = policies.find((p) => p.task === route.task) ?? policies.find((p) => p.task === "default");
  let wanted: ModelTarget[] = [...overrides, ...(policy ? [policy.primary as ModelTarget, ...(policy.fallbacks as ModelTarget[])] : [])];
  if (!policy) {
    const fallback = await prisma.providerConnection.findFirst({ where: { organizationId: route.organizationId, providerType: "llm", status: "active", isDefault: true } });
    const model = (fallback?.configuration as { defaultModel?: unknown } | undefined)?.defaultModel;
    if (fallback && typeof model === "string" && model) wanted.push({ credentialId: fallback.id, model });
  }
  if (wanted.length === 0) wanted = [{ credentialId: null, model: "" }];

  const ids = [...new Set(wanted.map((t) => t.credentialId).filter((id): id is string => id !== null))];
  const connections =
    ids.length > 0 ? await prisma.providerConnection.findMany({ where: { organizationId: route.organizationId, providerType: "llm", status: "active", id: { in: ids } } }) : [];
  const maxOutputTokens = maxOutputTokensFromEnv();
  const targets: RouteTarget[] = [];
  for (const target of wanted) {
    if (target.credentialId === null) {
      targets.push({ provider: platform.get(target.model || undefined), kind: platform.kind, credentialId: null, info: target.model ? modelInfo(platform.kind, target.model) : undefined });
      continue;
    }
    // A connection deleted or disabled after the policy or override was saved is skipped.
    const connection = connections.find((c) => c.id === target.credentialId);
    if (!connection) continue;
    if (!secret) throw new AIProviderError("config", "AI_CREDENTIALS_KEY is not set on the server, so the organization's keys cannot be read");
    targets.push(byoTarget(connection, target.model, secret, maxOutputTokens, create));
  }
  return {
    targets,
    maxCostUsd: policy?.maxCostUsd ?? null,
    timeoutMs: policy?.timeoutMs ?? null,
    allowedProviders: policy?.allowedProviders ?? [],
    strategy: (policy?.strategy ?? "ordered") as RoutePlan["strategy"],
  };
}

const configOfRow = (c: ConnectionRow) => c.configuration as { baseUrl?: string; models?: ModelInfo[] };

const byoTarget = (connection: ConnectionRow, model: string, secret: string, maxOutputTokens: number, create: ProviderFactory): RouteTarget => {
  const custom = connection.providerId === "openai_compatible";
  let apiKey: string;
  try {
    const opened = openCredentials(connection.encryptedCredentials, { current: secret, previous: previousSecretFromEnv() });
    apiKey = opened.credentials.apiKey ?? "";
    // Sealed under the previous server secret or in Phase 13's format: seal it again with the current one.
    if (opened.stale)
      void prisma.providerConnection
        .updateMany({ where: { id: connection.id, encryptedCredentials: connection.encryptedCredentials }, data: { encryptedCredentials: sealCredentials(opened.credentials, secret) } })
        .catch(() => {});
  } catch (err) {
    throw new AIProviderError("config", `The key "${connection.displayName}" cannot be read: AI_CREDENTIALS_KEY changed since it was saved. Rotate the key.`, err);
  }
  const { baseUrl, models } = configOfRow(connection);
  return {
    provider: create(connection.providerId, {
      model,
      maxOutputTokens,
      apiKey,
      ...(custom && baseUrl && { baseUrl: baseUrl.replace(/\/+$/, ""), fetch: safeFetch }),
    }),
    kind: connection.providerId,
    credentialId: connection.id,
    info: modelInfo(connection.providerId, model, models ?? []),
  };
};

/** The router the whole API uses. `ai.provider(route)` hands out providers bound to a route. */
export function modelRouter(platform: Platform, secret: string | null, log: FastifyBaseLogger, create?: ProviderFactory) {
  const record = ({ route, ...usage }: UsageRecord) => {
    prisma.aiUsage
      .create({
        data: {
          organizationId: route.organizationId,
          workspaceId: route.workspaceId ?? null,
          employeeId: route.employeeId ?? null,
          workflowId: route.workflowId ?? null,
          task: route.task,
          operation: "chat",
          ...usage,
          error: usage.error && scrubSecrets(usage.error),
        },
      })
      // An organization that does not exist (yet) or a database hiccup loses a usage row, never the reply.
      .catch((err: unknown) => log.warn({ err, route }, "Recording AI usage failed"));
  };
  return createRouter({ plan: (route) => planFor(route, platform, secret, create), record });
}

// ---- Routes ----

const taskParams = z.object({ task: z.enum(AI_TASKS) });
const idParams = z.object({ id: z.string().min(1) });
const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/** Phase 13's view of an LLM connection. */
const toCredential = (c: ConnectionRow): AiCredential => ({
  id: c.id,
  name: c.displayName,
  kind: c.providerId as AiProviderKind,
  baseUrl: configOfRow(c).baseUrl ?? null,
  keyHint: (c.credentialHints as { apiKey?: string }).apiKey ?? "",
  models: configOfRow(c).models ?? [],
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

/** A custom base URL must lead to a public address: the server makes the request, so it must not reach the private network. */
export async function assertPublicBaseUrl(baseUrl: string | null) {
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
      prisma.providerConnection.findMany({ where: { organizationId, providerType: "llm" }, orderBy: { createdAt: "asc" } }),
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
      const row = await prisma.providerConnection.create({
        data: {
          organizationId: auth.organizationId,
          providerType: "llm",
          providerId: body.kind,
          displayName: body.name,
          encryptedCredentials: sealCredentials({ apiKey: body.apiKey }, key),
          credentialHints: { apiKey: hintOf(body.apiKey) },
          configuration: { models: body.models, ...(body.baseUrl && { baseUrl: body.baseUrl }) },
          createdBy: auth.userId,
        },
      });
      await prisma.providerAuditLog.create({
        data: { organizationId: auth.organizationId, connectionId: row.id, providerType: "llm", providerId: body.kind, action: "create", actorId: auth.userId },
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
    const existing = await prisma.providerConnection.findFirst({ where: { id, organizationId: auth.organizationId, providerType: "llm" } });
    if (!existing) throw httpError(404, "Key not found");
    if (body.kind !== existing.providerId) throw httpError(400, "The provider of a key cannot change; add a new key instead");
    await assertPublicBaseUrl(body.baseUrl);
    try {
      const row = await prisma.providerConnection.update({
        where: { id },
        data: {
          displayName: body.name,
          configuration: { ...(existing.configuration as object), models: body.models, baseUrl: body.baseUrl ?? undefined },
          ...(body.apiKey && {
            encryptedCredentials: sealCredentials({ apiKey: body.apiKey }, needSecret()),
            credentialHints: { apiKey: hintOf(body.apiKey) },
            rotatedAt: new Date(),
          }),
        },
      });
      await prisma.providerAuditLog.create({
        data: { organizationId: auth.organizationId, connectionId: id, providerType: "llm", providerId: existing.providerId, action: body.apiKey ? "rotate" : "update", actorId: auth.userId },
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
    const existing = await prisma.providerConnection.findFirst({ where: { id, organizationId: auth.organizationId, providerType: "llm" } });
    if (!existing) throw httpError(404, "Key not found");
    const policies = await prisma.aiModelPolicy.findMany({ where: { organizationId: auth.organizationId } });
    const users = policies.filter((p) => [p.primary, ...(p.fallbacks as ModelTarget[])].some((t) => (t as ModelTarget).credentialId === id)).map((p) => p.task);
    if (users.length > 0) throw httpError(409, `Used by the ${users.join(", ")} model policy. Change those policies first.`);
    await prisma.providerConnection.delete({ where: { id } });
    await prisma.providerAuditLog.create({
      data: { organizationId: auth.organizationId, connectionId: id, providerType: "llm", providerId: existing.providerId, action: "delete", actorId: auth.userId },
    });
    return reply.code(204).send();
  });

  app.put("/ai/policies/:task", async (req): Promise<AiPolicy> => {
    const auth = admin(req);
    const { task } = taskParams.parse(req.params);
    const body = modelPolicySchema.parse(req.body);
    const targets = [body.primary, ...body.fallbacks];
    const ids = [...new Set(targets.map((t) => t.credentialId).filter((v): v is string => v !== null))];
    const owned = await prisma.providerConnection.findMany({ where: { organizationId: auth.organizationId, providerType: "llm", id: { in: ids } }, select: { id: true } });
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
    const where = { organizationId, providerType: "llm", createdAt: { gte: new Date(Date.now() - days * 86_400_000) } };
    const sums = { _sum: { inputTokens: true, outputTokens: true }, _avg: { latencyMs: true }, _count: { _all: true } } as const;
    // Costs only of the organization's own keys (its own vendor bill): the platform's provider cost is never shown (Phase 16).
    const ownKeys = { ...where, credentialId: { not: null } };
    const [byModel, failedByModel, byTask, fallbacks, recent, ownByModel, ownByTask] = await Promise.all([
      prisma.aiUsage.groupBy({ by: ["provider", "model"], where, ...sums }),
      prisma.aiUsage.groupBy({ by: ["provider", "model"], where: { ...where, success: false }, _count: { _all: true } }),
      prisma.aiUsage.groupBy({ by: ["task"], where, _count: { _all: true } }),
      prisma.aiUsage.count({ where: { ...where, attempt: { gt: 1 } } }),
      prisma.aiUsage.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.aiUsage.groupBy({ by: ["provider", "model"], where: ownKeys, _sum: { costUsd: true } }),
      prisma.aiUsage.groupBy({ by: ["task"], where: ownKeys, _sum: { costUsd: true } }),
    ]);
    const groups = byModel
      .map((g) => ({
        provider: g.provider,
        model: g.model,
        calls: g._count._all,
        failures: failedByModel.find((f) => f.provider === g.provider && f.model === g.model)?._count._all ?? 0,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        costUsd: ownByModel.find((o) => o.provider === g.provider && o.model === g.model)?._sum.costUsd ?? 0,
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
      byTask: byTask.map((t) => ({ task: t.task, calls: t._count._all, costUsd: ownByTask.find((o) => o.task === t.task)?._sum.costUsd ?? 0 })).sort((a, b) => b.calls - a.calls),
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
        costUsd: r.credentialId ? r.costUsd : null,
        latencyMs: r.latencyMs,
        success: r.success,
        errorKind: r.errorKind,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
